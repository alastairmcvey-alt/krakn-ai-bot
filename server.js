/**
 * KRAKN·AI — Trading Bot Backend Server v2.6
 * =============================================
 * AUD support, balance-aware AI signals, Telegram two-way chat,
 * auto-sell bot with smart small-holding logic, YES/NO buy prompts
 */

const express     = require('express');
const cors        = require('cors');
const crypto      = require('crypto');
const https       = require('https');
const querystring = require('querystring');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ─── Config ────────────────────────────────────────────────────
const KRAKEN_API_KEY    = (process.env.KRAKEN_API_KEY    || '').trim().replace(/[\r\n]/g, '');
const KRAKEN_API_SECRET = (process.env.KRAKEN_API_SECRET || '').trim().replace(/[\r\n]/g, '');
const KRAKEN_HOST       = 'api.kraken.com';
const TELEGRAM_TOKEN    = (process.env.TELEGRAM_BOT_TOKEN || '').trim().replace(/[\r\n]/g, '');
const TELEGRAM_CHAT_ID  = (process.env.TELEGRAM_CHAT_ID  || '').trim().replace(/[\r\n]/g, '');

// ─── AUD Pairs ─────────────────────────────────────────────────
const AUD_PAIRS = ['XBTAUD','ETHAUD','XRPAUD','ADAAUD','SOLAUD','LTCAUD','DOTAUD','LINKAUD'];
const PAIR_DISPLAY = {
  'XBTAUD':'BTC/AUD','ETHAUD':'ETH/AUD','XRPAUD':'XRP/AUD','ADAAUD':'ADA/AUD',
  'SOLAUD':'SOL/AUD','LTCAUD':'LTC/AUD','DOTAUD':'DOT/AUD','LINKAUD':'LINK/AUD'
};

// ─── Kraken Minimum Order Sizes ────────────────────────────────
const MIN_VOLUMES = {
  XBT:0.0001, ETH:0.002, SOL:0.02, XRP:5,
  ADA:5, LTC:0.02, DOT:0.5, LINK:0.2, UNI:0.2, MATIC:5
};

// ─── Advisor Settings ──────────────────────────────────────────
let advisorSettings = {
  enabled:       true,
  intervalHours: 1,
  pairs:         ['XBTAUD','ETHAUD','SOLAUD','XRPAUD'],
  minConfidence: 65,
  includeNews:   true,
  lastRun:       null,
};

// ─── State ─────────────────────────────────────────────────────
let priceAlerts          = [];
let pendingBuyOpportunity = null;
const chatHistory        = {};

// ─── Formatting Helpers ────────────────────────────────────────
function fmtAUDServer(p) {
  if (!p && p !== 0) return '--';
  if (p >= 1000) return 'A$' + Math.round(p).toLocaleString('en-AU');
  if (p >= 1)    return 'A$' + parseFloat(p).toFixed(2);
  return 'A$' + parseFloat(p).toFixed(4);
}
function fmtVolume(v) {
  return parseFloat(v) < 0.001 ? parseFloat(v).toFixed(8) : parseFloat(v).toFixed(4);
}

// ─── Kraken Signature ──────────────────────────────────────────
function getKrakenSignature(urlPath, data, secret, nonce) {
  const message       = querystring.stringify(data);
  const secret_buffer = Buffer.from(secret, 'base64');
  const hash          = crypto.createHash('sha256');
  const hmac          = crypto.createHmac('sha512', secret_buffer);
  const hash_digest   = hash.update(nonce + message).digest('binary');
  return hmac.update(urlPath + hash_digest, 'binary').digest('base64');
}

// ─── Kraken Private Request ────────────────────────────────────
function krakenPrivateRequest(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const nonce     = Date.now().toString();
    const urlPath   = '/0/private/' + endpoint;
    const data      = { nonce, ...params };
    const signature = getKrakenSignature(urlPath, data, KRAKEN_API_SECRET, nonce);
    const postData  = querystring.stringify(data);
    const options   = {
      hostname: KRAKEN_HOST, port: 443, path: urlPath, method: 'POST',
      headers: {
        'API-Key': KRAKEN_API_KEY, 'API-Sign': signature,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'KRAKN-AI-Bot/2.6'
      }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.error && parsed.error.length > 0) reject(new Error(parsed.error.join(', ')));
          else resolve(parsed.result);
        } catch (e) { reject(new Error('Invalid JSON from Kraken')); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ─── Kraken Public Request ─────────────────────────────────────
function krakenPublicRequest(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const query   = querystring.stringify(params);
    const path    = `/0/public/${endpoint}${query ? '?' + query : ''}`;
    const options = {
      hostname: KRAKEN_HOST, port: 443, path, method: 'GET',
      headers: { 'User-Agent': 'KRAKN-AI-Bot/2.6' }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.error && parsed.error.length > 0) reject(new Error(parsed.error.join(', ')));
          else resolve(parsed.result);
        } catch (e) { reject(new Error('Invalid JSON from Kraken')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Fetch Single Ticker Safely ────────────────────────────────
async function fetchSingleTicker(pair) {
  try {
    const result = await krakenPublicRequest('Ticker', { pair });
    const key    = Object.keys(result)[0];
    if (!key) return null;
    const data = result[key];
    return {
      price:     parseFloat(data.c[0]),
      bid:       parseFloat(data.b[0]),
      ask:       parseFloat(data.a[0]),
      high:      parseFloat(data.h[1]),
      low:       parseFloat(data.l[1]),
      volume:    parseFloat(data.v[1]),
      open:      parseFloat(data.o),
      change24h: (((parseFloat(data.c[0]) - parseFloat(data.o)) / parseFloat(data.o)) * 100).toFixed(2),
      currency:  'AUD'
    };
  } catch(e) {
    console.warn(`[TICKER] ${pair} failed: ${e.message}`);
    return null;
  }
}

// ─── Auth Middleware ───────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token || token !== process.env.BOT_SECRET_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function requireKeys(req, res, next) {
  if (!KRAKEN_API_KEY || !KRAKEN_API_SECRET) {
    return res.status(400).json({ error: 'Kraken API keys not configured.' });
  }
  next();
}

// ─── Telegram Send ─────────────────────────────────────────────
async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[TELEGRAM] Not configured');
    return { ok: false };
  }
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) console.error('[TELEGRAM ERROR]', parsed.description);
          else console.log('[TELEGRAM] Sent OK');
          resolve(parsed);
        } catch(e) { resolve({ ok: false }); }
      });
    });
    req.on('error', (e) => { console.error('[TELEGRAM ERROR]', e.message); resolve({ ok: false }); });
    req.write(body);
    req.end();
  });
}

async function sendTelegramTo(chatId, message) {
  if (!TELEGRAM_TOKEN) return;
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(null); } });
    });
    req.on('error', resolve);
    req.write(body);
    req.end();
  });
}

async function sendTyping(chatId) {
  if (!TELEGRAM_TOKEN) return;
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: chatId, action: 'typing' });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/sendChatAction`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => { res.on('data', ()=>{}); res.on('end', resolve); });
    req.on('error', resolve);
    req.write(body);
    req.end();
  });
}

// ─── Claude AI Helper ──────────────────────────────────────────
async function callClaude(prompt, maxTokens = 400, systemPrompt = null) {
  const body = {
    model: 'claude-sonnet-4-5',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }]
  };
  if (systemPrompt) body.system = systemPrompt;
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!data.content || !data.content.length) throw new Error(data.error?.message || 'Empty AI response');
  return data.content.map(i => i.text || '').join('');
}

// ─── Fetch Crypto News ─────────────────────────────────────────
async function fetchCryptoNews() {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 400,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: 'Search for the latest cryptocurrency market news from the last 2 hours. Focus on Bitcoin, Ethereum, Solana, XRP. Return a brief 2-3 sentence summary.' }]
      })
    });
    const data = await response.json();
    if (!data.content) return '';
    return data.content.filter(c => c.type === 'text').map(c => c.text).join(' ').slice(0, 600);
  } catch(e) {
    console.error('[NEWS ERROR]', e.message);
    return '';
  }
}

// ─── RSI Calculator ────────────────────────────────────────────
async function computeRSIForPair(pair) {
  try {
    const ohlc   = await krakenPublicRequest('OHLC', { pair, interval: 60 });
    const k      = Object.keys(ohlc).find(k => k !== 'last');
    const closes = ohlc[k].slice(-14).map(c => parseFloat(c[4]));
    const gains = [], losses = [];
    for (let i = 1; i < closes.length; i++) {
      const d = closes[i] - closes[i-1];
      gains.push(Math.max(d, 0));
      losses.push(Math.max(-d, 0));
    }
    const ag  = gains.reduce((a,b)=>a+b,0) / gains.length;
    const al  = losses.reduce((a,b)=>a+b,0) / losses.length;
    const rsi = 100 - (100 / (1 + (al === 0 ? 100 : ag/al)));
    let action = 'HOLD', confidence = 50;
    if (rsi > 70) {
      action     = 'SELL';
      confidence = Math.min(95, 60 + (rsi - 70) * 2);
    } else if (rsi > 60) {
      action     = 'SELL';
      confidence = Math.min(70, 50 + (rsi - 60) * 2);
    }
    if (botConfig.riskLevel === 'conservative') confidence *= 0.85;
    if (botConfig.riskLevel === 'aggressive')   confidence *= 1.10;
    return { action, confidence: Math.min(99, Math.round(confidence)), rsi: Math.round(rsi) };
  } catch {
    return { action: 'HOLD', confidence: 0, rsi: 50 };
  }
}

// ─── Advisor ───────────────────────────────────────────────────
let advisorTimer = null;

function scheduleAdvisor() {
  if (advisorTimer) clearInterval(advisorTimer);
  const ms = advisorSettings.intervalHours * 60 * 60 * 1000;
  advisorTimer = setInterval(() => { if (advisorSettings.enabled) runAdvisor(); }, ms);
  console.log(`[ADVISOR] Scheduled every ${advisorSettings.intervalHours}h`);
}

async function runAdvisor() {
  console.log('[ADVISOR] Running...');
  advisorSettings.lastRun = new Date().toISOString();
  try {
    const marketData = [];
    for (const pair of advisorSettings.pairs) {
      const ticker = await fetchSingleTicker(pair);
      if (!ticker) continue;
      let rsi = 50;
      try {
        const ohlc    = await krakenPublicRequest('OHLC', { pair, interval: 60 });
        const ohlcKey = Object.keys(ohlc).find(k => k !== 'last');
        const closes  = ohlc[ohlcKey].slice(-14).map(c => parseFloat(c[4]));
        const gains = [], losses = [];
        for (let i = 1; i < closes.length; i++) {
          const diff = closes[i] - closes[i-1];
          gains.push(Math.max(diff, 0)); losses.push(Math.max(-diff, 0));
        }
        const ag = gains.reduce((a,b)=>a+b,0)/gains.length;
        const al = losses.reduce((a,b)=>a+b,0)/losses.length;
        rsi = Math.round(100 - (100/(1+(al===0?100:ag/al))));
      } catch(e) {}
      marketData.push({ pair, displayPair: PAIR_DISPLAY[pair]||pair, ...ticker, rsi });
    }

    if (!marketData.length) return;

    let balanceContext = '';
    if (KRAKEN_API_KEY && KRAKEN_API_SECRET) {
      try {
        const bal    = await krakenPrivateRequest('Balance');
        const audBal = parseFloat(bal['ZAUD'] || bal['AUD'] || 0);
        if (audBal > 0) balanceContext = `\nYour available AUD cash: ${fmtAUDServer(audBal)}`;
      } catch(e) {}
    }

    const newsContext   = advisorSettings.includeNews ? await fetchCryptoNews() : '';
    const marketSummary = marketData.map(d =>
      `${d.displayPair}: ${fmtAUDServer(d.price)} (${d.change24h > 0 ? '+' : ''}${d.change24h}% 24h, RSI: ${d.rsi}, High: ${fmtAUDServer(d.high)}, Low: ${fmtAUDServer(d.low)})`
    ).join('\n');

    const sydneyTime = new Date().toLocaleString('en-AU', { timeZone:'Australia/Sydney', dateStyle:'short', timeStyle:'short' });

    const prompt = `You are an expert crypto trading advisor for an Australian retail investor.

IMPORTANT: All prices are ALREADY in Australian Dollars (AUD) from Kraken's AUD trading pairs. Do NOT convert from USD. Do NOT mention price differences between AUD and USD.

CURRENT AUD MARKET DATA:
${marketSummary}
${balanceContext}
${newsContext ? `\nLATEST NEWS:\n${newsContext}` : ''}

Give clear actionable trading advice. For each coin provide BUY/SELL/HOLD, confidence %, and one sentence reason. No mention of currency conversion.

Format EXACTLY like this:
🤖 <b>KRAKN·AI Market Update</b>
⏰ ${sydneyTime} AEST

For each coin:
[emoji] <b>[PAIR]</b> — $[price] AUD
[action emoji] <b>[BUY/SELL/HOLD]</b> [confidence]% — [reason]
${balanceContext ? '💰 Suggested: $[amount] AUD' : ''}

Use 🟢 BUY, 🔴 SELL, 🟡 HOLD. Use 📈 if up, 📉 if down.
${newsContext ? '\n📰 <b>NEWS:</b> [one sentence]' : ''}

Only include coins above ${advisorSettings.minConfidence}% confidence. If none qualify say "No strong signals right now."`;

    const advice = await callClaude(prompt, 700);
    if (advice) {
      await sendTelegram(advice);
      console.log('[ADVISOR] Telegram sent');
    }

    await checkBuyOpportunities(marketData);

  } catch(err) {
    console.error('[ADVISOR ERROR]', err.message);
  }
}

// ─── Buy Opportunity Detector ──────────────────────────────────
async function checkBuyOpportunities(marketData) {
  try {
    let audCash = 0;
    if (KRAKEN_API_KEY && KRAKEN_API_SECRET) {
      const bal = await krakenPrivateRequest('Balance');
      audCash   = parseFloat(bal['ZAUD'] || bal['AUD'] || 0);
    }
    if (audCash < 10) return;

    let bestOpportunity = null;
    for (const d of marketData) {
      if (d.rsi < 30) {
        const confidence = Math.min(95, 60 + (30 - d.rsi) * 2);
        if (confidence >= advisorSettings.minConfidence) {
          if (!bestOpportunity || confidence > bestOpportunity.confidence) {
            bestOpportunity = { ...d, confidence };
          }
        }
      }
    }

    if (!bestOpportunity) return;

    const suggestedAUD = Math.min(audCash * 0.25, audCash - 10);
    if (suggestedAUD < 10) return;

    const volume = (suggestedAUD / bestOpportunity.price).toFixed(8);

    pendingBuyOpportunity = {
      pair:        bestOpportunity.pair,
      displayPair: bestOpportunity.displayPair,
      sym:         bestOpportunity.displayPair.replace('/AUD',''),
      price:       bestOpportunity.price,
      amountAUD:   suggestedAUD,
      volume,
      rsi:         bestOpportunity.rsi,
      confidence:  bestOpportunity.confidence,
      timestamp:   Date.now(),
    };

    const sydneyTime = new Date().toLocaleString('en-AU', { timeZone:'Australia/Sydney', dateStyle:'short', timeStyle:'short' });

    await sendTelegram(
      `🟢 <b>BUY OPPORTUNITY DETECTED!</b>\n\n` +
      `<b>${bestOpportunity.displayPair}</b>\n` +
      `Price: ${fmtAUDServer(bestOpportunity.price)}\n` +
      `RSI: ${bestOpportunity.rsi} (Oversold 🔥)\n` +
      `Confidence: ${bestOpportunity.confidence}%\n` +
      `24h Change: ${bestOpportunity.change24h > 0 ? '+' : ''}${bestOpportunity.change24h}%\n` +
      `High: ${fmtAUDServer(bestOpportunity.high)} | Low: ${fmtAUDServer(bestOpportunity.low)}\n\n` +
      `💰 Suggested: <b>${fmtAUDServer(suggestedAUD)}</b> (25% of your AUD cash)\n` +
      `= ${volume} ${pendingBuyOpportunity.sym}\n\n` +
      `Reply <b>YES</b> to buy now or <b>NO</b> to skip.\n` +
      `⏰ Expires in 10 minutes — ${sydneyTime} AEST`
    );

    console.log(`[BUY OPPORTUNITY] ${bestOpportunity.displayPair} RSI:${bestOpportunity.rsi} — prompt sent`);

  } catch(e) {
    console.error('[BUY OPPORTUNITY ERROR]', e.message);
  }
}

// ─── Price Alert Checker ───────────────────────────────────────
async function checkPriceAlerts() {
  const active = priceAlerts.filter(a => !a.triggered);
  if (!active.length) return;
  for (const alert of active) {
    try {
      const ticker = await fetchSingleTicker(alert.pair);
      if (!ticker) continue;
      const currentPrice = ticker.price;
      const triggered =
        (alert.condition === 'above' && currentPrice >= alert.targetPrice) ||
        (alert.condition === 'below' && currentPrice <= alert.targetPrice);
      if (triggered) {
        alert.triggered      = true;
        alert.triggeredAt    = new Date().toISOString();
        alert.triggeredPrice = currentPrice;
        const dp         = PAIR_DISPLAY[alert.pair] || alert.pair;
        const emoji      = alert.condition === 'above' ? '🚀' : '📉';
        const sydneyTime = new Date().toLocaleString('en-AU', { timeZone:'Australia/Sydney', dateStyle:'short', timeStyle:'short' });
        await sendTelegram(
          `${emoji} <b>KRAKN·AI Price Alert!</b>\n\n` +
          `<b>${dp}</b> is now <b>${fmtAUDServer(currentPrice)}</b>\n` +
          `Alert: Price ${alert.condition} ${fmtAUDServer(alert.targetPrice)}\n\n` +
          `⏰ ${sydneyTime} AEST`
        );
      }
    } catch(e) {}
  }
}

setInterval(checkPriceAlerts, 60000);
scheduleAdvisor();
setTimeout(() => { if (advisorSettings.enabled) runAdvisor(); }, 15000);

// ─── Telegram Webhook Registration ────────────────────────────
async function registerTelegramWebhook() {
  if (!TELEGRAM_TOKEN) return;
  try {
    const serverUrl = process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN;
    if (!serverUrl) { console.log('[TELEGRAM] No public URL — webhook not registered'); return; }
    const webhookUrl = `https://${serverUrl}/api/telegram/webhook`;
    const body       = JSON.stringify({ url: webhookUrl });
    await new Promise((resolve) => {
      const options = {
        hostname: 'api.telegram.org',
        path: `/bot${TELEGRAM_TOKEN}/setWebhook`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { const r = JSON.parse(data); console.log('[TELEGRAM] Webhook:', r.ok ? '✅' : '❌ ' + r.description); } catch(e) {}
          resolve();
        });
      });
      req.on('error', () => resolve());
      req.write(body);
      req.end();
    });
  } catch(e) { console.error('[WEBHOOK ERROR]', e.message); }
}

// ─── Telegram Chat Handler ─────────────────────────────────────
async function handleTelegramMessage(chatId, userMessage, username) {
  if (String(chatId) !== String(TELEGRAM_CHAT_ID)) {
    await sendTelegramTo(chatId, '⛔ Unauthorised. This bot is private.');
    return;
  }

  console.log(`[TELEGRAM CHAT] ${username}: ${userMessage}`);
  await sendTyping(chatId);

  const msg = userMessage.trim().toLowerCase();

  if (msg === '/start' || msg === 'start') {
    await sendTelegramTo(chatId,
      '🤖 <b>KRAKN·AI Assistant</b>\n\n' +
      'Ask me anything about crypto!\n\n' +
      '• "How is BTC looking right now?"\n' +
      '• "Should I buy ETH?"\n' +
      '• "What\'s my portfolio worth?"\n' +
      '• "Run market analysis"\n' +
      '• "What\'s happening in crypto today?"\n\n' +
      '💡 Reply <b>YES</b> to buy prompts or <b>NO</b> to skip.'
    );
    return;
  }

  if (msg === 'run analysis' || msg === '/analysis' || msg === 'analyse' || msg === 'analyze') {
    await sendTelegramTo(chatId, '⏳ Running full market analysis... give me 30 seconds!');
    await runAdvisor();
    return;
  }

  if (msg === 'yes' || msg === 'yes!' || msg === 'y' || msg === '/yes') {
    if (!pendingBuyOpportunity) {
      await sendTelegramTo(chatId, '🤔 No pending buy opportunity. Ask me about a coin first!');
      return;
    }
    const opp = pendingBuyOpportunity;
    pendingBuyOpportunity = null;
    const age = (Date.now() - opp.timestamp) / 1000 / 60;
    if (age > 10) {
      await sendTelegramTo(chatId, `⏰ That opportunity expired ${Math.round(age)} minutes ago. Ask me again for a fresh signal!`);
      return;
    }
    await sendTelegramTo(chatId,
      `⏳ <b>Placing buy order...</b>\n\nBuying ${fmtVolume(opp.volume)} <b>${opp.sym}</b>\n≈ ${fmtAUDServer(opp.amountAUD)}`
    );
    try {
      const ticker      = await fetchSingleTicker(opp.pair);
      const freshPrice  = ticker ? ticker.price : opp.price;
      const freshVolume = (opp.amountAUD / freshPrice).toFixed(8);
      const order       = await krakenPrivateRequest('AddOrder', {
        pair: opp.pair, type: 'buy', ordertype: 'market', volume: freshVolume,
      });
      const valueAUD   = (parseFloat(freshVolume) * freshPrice).toFixed(2);
      const sydneyTime = new Date().toLocaleString('en-AU', { timeZone:'Australia/Sydney', dateStyle:'short', timeStyle:'short' });
      await sendTelegramTo(chatId,
        `🟢 <b>BUY ORDER PLACED!</b>\n\n` +
        `<b>${opp.displayPair}</b>\n` +
        `Bought: ${freshVolume} ${opp.sym}\n` +
        `Price: ${fmtAUDServer(freshPrice)}\n` +
        `Total: ≈ ${fmtAUDServer(parseFloat(valueAUD))}\n` +
        `TXID: ${order.txid?.join(', ')}\n\n` +
        `⏰ ${sydneyTime} AEST\n\nGood luck! 🚀`
      );
    } catch(orderErr) {
      await sendTelegramTo(chatId,
        `❌ <b>BUY ORDER FAILED</b>\n\nError: ${orderErr.message}\n\nPlease try manually in the app.`
      );
    }
    return;
  }

  if (msg === 'no' || msg === 'no!' || msg === 'n' || msg === '/no') {
    if (pendingBuyOpportunity) {
      const opp = pendingBuyOpportunity;
      pendingBuyOpportunity = null;
      await sendTelegramTo(chatId, `👍 Skipped ${opp.sym} buy. I'll keep watching!`);
    } else {
      await sendTelegramTo(chatId, '👍 No problem!');
    }
    return;
  }

  // General AI chat
  let marketContext = '';
  try {
    const lines = [];
    for (const pair of ['XBTAUD','ETHAUD','SOLAUD','XRPAUD','ADAAUD']) {
      const ticker = await fetchSingleTicker(pair);
      if (ticker) lines.push(`${PAIR_DISPLAY[pair]||pair}: ${fmtAUDServer(ticker.price)} (${ticker.change24h > 0 ? '+' : ''}${ticker.change24h}% 24h)`);
    }
    if (lines.length) marketContext = '\nCURRENT AUD PRICES:\n' + lines.join('\n');
  } catch(e) {}

  let balanceContext = '';
  try {
    if (KRAKEN_API_KEY && KRAKEN_API_SECRET) {
      const bal    = await krakenPrivateRequest('Balance');
      const audBal = parseFloat(bal['ZAUD'] || bal['AUD'] || 0);
      const lines  = [];
      if (audBal > 0) lines.push(`AUD Cash: ${fmtAUDServer(audBal)}`);
      for (const [asset, qty] of Object.entries(bal)) {
        if (asset === 'ZAUD' || asset === 'AUD') continue;
        if (parseFloat(qty) > 0.000001) {
          const s      = asset.replace(/^X/,'').replace(/Z$/,'').replace('XBT','BTC');
          const pair   = Object.keys(PAIR_DISPLAY).find(p => p.includes(s === 'BTC' ? 'XBT' : s));
          const ticker = pair ? await fetchSingleTicker(pair) : null;
          const val    = ticker ? fmtAUDServer(parseFloat(qty) * ticker.price) : '?';
          lines.push(`${s}: ${parseFloat(qty).toFixed(6)} (≈ ${val})`);
        }
      }
      if (lines.length) balanceContext = '\nYOUR PORTFOLIO:\n' + lines.join('\n');
    }
  } catch(e) {}

  const sydneyTime = new Date().toLocaleString('en-AU', { timeZone:'Australia/Sydney', dateStyle:'short', timeStyle:'short' });

  const systemPrompt = `You are KRAKN·AI, a personal cryptocurrency trading assistant for an Australian investor. Be helpful, concise, and speak plainly.

IMPORTANT: All prices are in Australian Dollars (AUD) directly from Kraken. Do NOT convert from USD. Do NOT mention price differences.
${marketContext}
${balanceContext}
Current time: ${sydneyTime} AEST

Keep responses concise for Telegram. Use HTML: <b>bold</b> for key info. Be honest — crypto is volatile. Never guarantee outcomes.`;

  if (!chatHistory[chatId]) chatHistory[chatId] = [];
  chatHistory[chatId].push({ role: 'user', content: userMessage });
  if (chatHistory[chatId].length > 12) chatHistory[chatId] = chatHistory[chatId].slice(-12);

  try {
    const typingInterval = setInterval(() => sendTyping(chatId), 4000);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 600,
        system: systemPrompt,
        messages: chatHistory[chatId]
      })
    });
    clearInterval(typingInterval);
    const data  = await response.json();
    const reply = data.content?.map(c => c.text || '').join('') || 'Sorry, I had trouble with that.';
    chatHistory[chatId].push({ role: 'assistant', content: reply });
    await sendTelegramTo(chatId, reply);
  } catch(err) {
    console.error('[TELEGRAM CHAT ERROR]', err.message);
    await sendTelegramTo(chatId, '❌ Sorry, I had an error. Try again in a moment.');
  }
}

// ─── Telegram Webhook Endpoint ─────────────────────────────────
app.post('/api/telegram/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const update  = req.body;
    const message = update.message || update.edited_message;
    if (!message || !message.text) return;
    const chatId   = message.chat.id;
    const text     = message.text;
    const username = message.from?.username || message.from?.first_name || 'User';
    handleTelegramMessage(chatId, text, username).catch(e => console.error('[WEBHOOK ERROR]', e.message));
  } catch(e) { console.error('[WEBHOOK PARSE ERROR]', e.message); }
});

// ══════════════════════════════════════════════════════════════
// API ROUTES
// ══════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({
    status: 'online', version: '2.6',
    keysConfigured: !!(KRAKEN_API_KEY && KRAKEN_API_SECRET),
    aiConfigured: !!(process.env.ANTHROPIC_API_KEY),
    telegramConfigured: !!(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID),
    advisorEnabled: advisorSettings.enabled,
    advisorInterval: advisorSettings.intervalHours,
    currency: 'AUD',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/ticker', async (req, res) => {
  try {
    const requestedPairs = (req.query.pairs || AUD_PAIRS.join(',')).split(',');
    const tickers = {};
    await Promise.all(requestedPairs.map(async (pair) => {
      const data = await fetchSingleTicker(pair.trim());
      if (data) tickers[pair.trim()] = data;
    }));
    res.json({ success: true, data: tickers, currency: 'AUD' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/ohlc', async (req, res) => {
  try {
    const { pair = 'XBTAUD', interval = 60 } = req.query;
    const result = await krakenPublicRequest('OHLC', { pair, interval: parseInt(interval) });
    const key    = Object.keys(result).find(k => k !== 'last');
    res.json({ success: true, data: result[key], last: result.last });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/balance', requireAuth, requireKeys, async (req, res) => {
  try {
    const result   = await krakenPrivateRequest('Balance');
    const balances = {};
    for (const [asset, amount] of Object.entries(result)) {
      if (parseFloat(amount) > 0) balances[asset] = parseFloat(amount);
    }
    res.json({ success: true, data: balances });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/orders/open', requireAuth, requireKeys, async (req, res) => {
  try {
    const result = await krakenPrivateRequest('OpenOrders');
    res.json({ success: true, data: result.open || {} });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/orders/closed', requireAuth, requireKeys, async (req, res) => {
  try {
    const result = await krakenPrivateRequest('ClosedOrders');
    res.json({ success: true, data: result.closed || {} });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/trades', requireAuth, requireKeys, async (req, res) => {
  try {
    const result = await krakenPrivateRequest('TradesHistory');
    res.json({ success: true, data: result.trades || {} });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ai/signal', requireAuth, async (req, res) => {
  try {
    const { pair, price, change24h, balanceAUD } = req.body;
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not configured' });

    const displayPair = PAIR_DISPLAY[pair] || pair;
    let rsi = 50;
    try {
      const ohlc    = await krakenPublicRequest('OHLC', { pair, interval: 60 });
      const ohlcKey = Object.keys(ohlc).find(k => k !== 'last');
      const closes  = ohlc[ohlcKey].slice(-14).map(c => parseFloat(c[4]));
      const gains = [], losses = [];
      for (let i = 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i-1];
        gains.push(Math.max(diff,0)); losses.push(Math.max(-diff,0));
      }
      const ag = gains.reduce((a,b)=>a+b,0)/gains.length;
      const al = losses.reduce((a,b)=>a+b,0)/losses.length;
      rsi = Math.round(100 - (100/(1+(al===0?100:ag/al))));
    } catch(e) {}

    const balanceNote = balanceAUD && balanceAUD > 0
      ? `\nThe investor has ${fmtAUDServer(parseFloat(balanceAUD))} AUD available to trade.`
      : '';

    const prompt = `You are a crypto trading AI for an Australian retail investor.

IMPORTANT: All prices are ALREADY in Australian Dollars (AUD) from Kraken. Do NOT convert from USD. Do NOT mention currency differences.

Analyse ${displayPair} at ${fmtAUDServer(parseFloat(price))} (${change24h > 0 ? '+' : ''}${change24h}% 24h, RSI: ${rsi}).${balanceNote}

Return ONLY this JSON (no markdown):
{
  "action": "BUY",
  "confidence": 72,
  "reason": "Brief 1-2 sentence beginner-friendly reason focused on technicals only",
  "support": 150000,
  "resistance": 165000,
  "risk": "Medium",
  "rsi": ${rsi},
  "rsi_signal": "Neutral",
  "macd": "Bullish",
  "trend": "Uptrend",
  "suggestedAmountAUD": ${balanceAUD && balanceAUD > 0 ? 'conservative suggested amount as number' : 'null'},
  "suggestedPct": ${balanceAUD && balanceAUD > 0 ? 'suggested % of balance as number e.g. 25' : 'null'}
}

For suggestedAmountAUD: suggest 10-30% of balance for medium confidence, up to 40% for high confidence BUY. Never more than 50%. Return null if HOLD or no balance.`;

    const text   = await callClaude(prompt, 400);
    const clean  = text.replace(/```json|```/g, '').trim();
    const signal = JSON.parse(clean);
    res.json({ success: true, data: signal });
  } catch (err) {
    console.error('[AI SIGNAL ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/advisor/settings', requireAuth, (req, res) => {
  res.json({ success: true, data: { ...advisorSettings } });
});
app.post('/api/advisor/settings', requireAuth, (req, res) => {
  const { intervalHours, enabled, pairs, minConfidence, includeNews } = req.body;
  if (intervalHours)             advisorSettings.intervalHours = parseInt(intervalHours);
  if (enabled !== undefined)     advisorSettings.enabled       = enabled;
  if (pairs)                     advisorSettings.pairs         = pairs;
  if (minConfidence)             advisorSettings.minConfidence = parseInt(minConfidence);
  if (includeNews !== undefined) advisorSettings.includeNews   = includeNews;
  scheduleAdvisor();
  res.json({ success: true, data: advisorSettings });
});
app.post('/api/advisor/run', requireAuth, async (req, res) => {
  res.json({ success: true, message: 'Running — check Telegram in ~30 seconds!' });
  runAdvisor();
});

app.get('/api/alerts', requireAuth, (req, res) => {
  res.json({ success: true, data: priceAlerts });
});
app.post('/api/alerts', requireAuth, async (req, res) => {
  const { pair, targetPrice, condition } = req.body;
  if (!pair || !targetPrice || !condition) return res.status(400).json({ error: 'pair, targetPrice and condition required' });
  const alert = { id: Date.now().toString(), pair, targetPrice: parseFloat(targetPrice), condition, triggered: false, createdAt: new Date().toISOString() };
  priceAlerts.push(alert);
  const dp = PAIR_DISPLAY[pair] || pair;
  await sendTelegram(`🔔 <b>Alert Set!</b>\n\n<b>${dp}</b> — notify when ${condition} ${fmtAUDServer(parseFloat(targetPrice))}`);
  res.json({ success: true, data: alert });
});
app.delete('/api/alerts/:id', requireAuth, (req, res) => {
  const before = priceAlerts.length;
  priceAlerts  = priceAlerts.filter(a => a.id !== req.params.id);
  if (priceAlerts.length < before) res.json({ success: true });
  else res.status(404).json({ error: 'Alert not found' });
});

app.post('/api/telegram/test', requireAuth, async (req, res) => {
  try {
    const result = await sendTelegram(
      '🤖 <b>KRAKN·AI v2.6 Connected!</b>\n\n' +
      '✅ Telegram notifications working!\n\n' +
      'You will receive:\n' +
      '📊 Scheduled AI market analysis\n' +
      '🟢 YES/NO buy prompts\n' +
      '🔴 Auto-sell notifications\n' +
      '🔔 Price alerts\n' +
      '📰 Latest crypto news\n\n' +
      '💬 Chat with me anytime!\n\n' +
      '🇦🇺 All prices in AUD'
    );
    if (result && result.ok) res.json({ success: true, message: 'Test sent!' });
    else res.status(500).json({ error: 'Telegram error: ' + JSON.stringify(result) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/order/place', requireAuth, requireKeys, async (req, res) => {
  try {
    const { pair, type, ordertype, volume, price, leverage, validate } = req.body;
    if (!pair || !type || !ordertype || !volume) return res.status(400).json({ error: 'Missing fields' });
    const params = { pair, type, ordertype, volume: String(volume) };
    if (price)    params.price    = String(price);
    if (leverage) params.leverage = String(leverage);
    if (validate) params.validate = true;
    const result = await krakenPrivateRequest('AddOrder', params);
    if (!validate) {
      const dp    = PAIR_DISPLAY[pair] || pair;
      const emoji = type === 'buy' ? '🟢' : '🔴';
      sendTelegram(`${emoji} <b>Order Placed!</b>\n\n${type.toUpperCase()} ${volume} <b>${dp}</b>\nType: ${ordertype}\nTXID: ${result.txid?.join(', ')}`);
    }
    res.json({ success: true, data: { txid: result.txid, description: result.descr, message: validate ? 'Validated' : 'Order placed!' } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/order/cancel', requireAuth, requireKeys, async (req, res) => {
  try {
    const { txid } = req.body;
    if (!txid) return res.status(400).json({ error: 'txid required' });
    res.json({ success: true, data: await krakenPrivateRequest('CancelOrder', { txid }) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/order/cancel-all', requireAuth, requireKeys, async (req, res) => {
  try { res.json({ success: true, data: await krakenPrivateRequest('CancelAll') }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════
// AUTO-SELL BOT
// ══════════════════════════════════════════════════════════════
let botConfig = {
  riskLevel:     'conservative',
  sellPct:       25,
  confidenceMin: 75,
  checkInterval: 60,
};
let botState = {
  running:     false,
  lastCheck:   null,
  lastSell:    null,
  sellsCount:  0,
  lastSignals: {},
};

app.get('/api/bot/config',  requireAuth, (req, res) => res.json({ success:true, data:{ ...botConfig, state:botState } }));
app.post('/api/bot/config', requireAuth, (req, res) => { botConfig={ ...botConfig, ...req.body }; res.json({ success:true, data:botConfig }); });
app.get('/api/bot/status',  requireAuth, (req, res) => res.json({ success:true, data:botState }));

app.post('/api/bot/start', requireAuth, requireKeys, (req, res) => {
  if (botState.running) return res.json({ success:true, message:'Already running' });
  botState.running = true;
  console.log('[AUTO-SELL BOT] Started');
  sendTelegram(
    '🤖 <b>KRAKN·AI Auto-Sell Bot Started!</b>\n\n' +
    `Watching ALL your holdings every ${botConfig.checkInterval} seconds.\n` +
    `Will auto-sell <b>${botConfig.sellPct}%</b> of holdings when RSI signals overbought.\n` +
    `Holdings under <b>A$20</b> will be fully liquidated to free up capital.\n` +
    `Min confidence: <b>${botConfig.confidenceMin}%</b>\n\n` +
    '⚠️ You will receive a Telegram alert before and after every sell.'
  );
  startAutoSellLoop();
  res.json({ success:true, message:'Auto-sell bot started' });
});

app.post('/api/bot/stop', requireAuth, (req, res) => {
  botState.running = false;
  console.log('[AUTO-SELL BOT] Stopped');
  sendTelegram('⏸ <b>KRAKN·AI Auto-Sell Bot Paused</b>\nNo more automatic sells will happen.');
  res.json({ success:true, message:'Bot stopped' });
});

async function startAutoSellLoop() {
  while (botState.running) {
    try { await runAutoSellCheck(); }
    catch(e) { console.error('[AUTO-SELL BOT ERROR]', e.message); }
    await new Promise(r => setTimeout(r, botConfig.checkInterval * 1000));
  }
}

async function runAutoSellCheck() {
  botState.lastCheck = new Date().toISOString();
  console.log('[AUTO-SELL BOT] Checking all holdings...');

  let balance;
  try { balance = await krakenPrivateRequest('Balance'); }
  catch(e) { console.error('[AUTO-SELL BOT] Balance fetch failed:', e.message); return; }

  const holdings = [];
  for (const [asset, qty] of Object.entries(balance)) {
    const amount = parseFloat(qty);
    if (amount < 0.000001) continue;
    if (asset === 'ZAUD' || asset === 'AUD') continue;
    const sym  = asset.replace(/^X/, '').replace(/Z$/, '');
    const pair = AUD_PAIRS.find(p =>
      p.replace('AUD','') === sym ||
      p.replace('AUD','') === sym.replace('XBT','BTC').replace('BTC','XBT')
    );
    if (!pair) continue;
    holdings.push({ asset, sym, qty: amount, pair });
  }

  if (!holdings.length) { console.log('[AUTO-SELL BOT] No holdings to check'); return; }
  console.log(`[AUTO-SELL BOT] Checking: ${holdings.map(h=>h.sym).join(', ')}`);

  for (const holding of holdings) {
    try {
      const ticker = await fetchSingleTicker(holding.pair);
      if (!ticker) continue;

      const signal = await computeRSIForPair(holding.pair);
      botState.lastSignals[holding.pair] = {
        ...signal, price: ticker.price, checkedAt: new Date().toISOString()
      };

      const dp = PAIR_DISPLAY[holding.pair] || holding.pair;
      console.log(`[AUTO-SELL BOT] ${dp} RSI:${signal.rsi} ${signal.action} ${signal.confidence}%`);

      if (signal.action !== 'SELL') continue;
      if (signal.confidence < botConfig.confidenceMin) {
        console.log(`[AUTO-SELL BOT] ${dp} skipped — confidence ${signal.confidence}% < ${botConfig.confidenceMin}%`);
        continue;
      }

      // ── Smart Sell Sizing ─────────────────────────────────
      const holdingValueAUD = holding.qty * ticker.price;
      const minVol          = MIN_VOLUMES[holding.sym] || 0.0001;
      let sellQty, sellReason;

      if (holdingValueAUD < 20) {
        // Small holding — sell ALL to free up capital
        sellQty    = holding.qty;
        sellReason = `Small holding (${fmtAUDServer(holdingValueAUD)}) — selling all to free up capital`;
        console.log(`[AUTO-SELL BOT] ${dp} small holding — selling all`);
      } else {
        // Normal holding — sell configured %
        sellQty    = holding.qty * (botConfig.sellPct / 100);
        sellReason = `Selling ${botConfig.sellPct}% of holding`;
      }

      // Final minimum order check
      if (sellQty < minVol) {
        console.log(`[AUTO-SELL BOT] ${dp} skipped — ${sellQty.toFixed(8)} below Kraken minimum ${minVol}`);
        await sendTelegram(
          `ℹ️ <b>Auto-Sell Skipped — ${dp}</b>\n\n` +
          `Sell amount ${fmtVolume(sellQty)} ${holding.sym} is below Kraken's minimum (${minVol} ${holding.sym}).\n\n` +
          `💡 Sell manually in the app or increase your sell % in Bot settings.`
        );
        continue;
      }

      const sellVolume   = sellQty.toFixed(8);
      const sellValueAUD = (sellQty * ticker.price).toFixed(2);

      // Pre-sell warning
      await sendTelegram(
        `⚠️ <b>AUTO-SELL TRIGGERED!</b>\n\n` +
        `<b>${dp}</b>\n` +
        `RSI: ${signal.rsi} (Overbought) | Confidence: ${signal.confidence}%\n` +
        `Current price: ${fmtAUDServer(ticker.price)}\n\n` +
        `${sellReason}\n` +
        `Amount: ${sellVolume} ${holding.sym} (≈ ${fmtAUDServer(parseFloat(sellValueAUD))})\n\n` +
        `⏳ Placing order now...`
      );

      // Place sell order
      try {
        const order = await krakenPrivateRequest('AddOrder', {
          pair: holding.pair, type: 'sell', ordertype: 'market', volume: sellVolume,
        });

        botState.lastSell = {
          pair: holding.pair, sym: holding.sym,
          volume: sellVolume, price: ticker.price,
          valueAUD: sellValueAUD, txid: order.txid,
          timestamp: new Date().toISOString()
        };
        botState.sellsCount++;

        const sydneyTime = new Date().toLocaleString('en-AU', {
          timeZone:'Australia/Sydney', dateStyle:'short', timeStyle:'short'
        });

        await sendTelegram(
          `🔴 <b>AUTO-SELL COMPLETED!</b>\n\n` +
          `<b>${dp}</b>\n` +
          `Sold: ${sellVolume} ${holding.sym}\n` +
          `Price: ${fmtAUDServer(ticker.price)}\n` +
          `Value: ≈ ${fmtAUDServer(parseFloat(sellValueAUD))}\n` +
          `TXID: ${order.txid?.join(', ')}\n\n` +
          `RSI was ${signal.rsi} — overbought signal.\n` +
          `Remaining: ${(holding.qty - parseFloat(sellVolume)).toFixed(8)} ${holding.sym}\n\n` +
          `⏰ ${sydneyTime} AEST`
        );

        console.log(`[AUTO-SELL BOT] ✅ Sold ${sellVolume} ${holding.sym} @ ${fmtAUDServer(ticker.price)}`);

      } catch(orderErr) {
        console.error(`[AUTO-SELL BOT] Order failed for ${holding.sym}:`, orderErr.message);
        await sendTelegram(
          `❌ <b>AUTO-SELL FAILED!</b>\n\n` +
          `<b>${dp}</b> — Could not place sell order\n` +
          `Error: ${orderErr.message}\n\n` +
          `Please check the app and sell manually if needed.`
        );
      }

      await new Promise(r => setTimeout(r, 2000));

    } catch(e) {
      console.error(`[AUTO-SELL BOT] Error checking ${holding.sym}:`, e.message);
    }
  }
}

// ─── Start Server ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║        KRAKN·AI Bot Server v2.6        ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  Port:     ${PORT}                         ║`);
  console.log(`║  Currency: 🇦🇺 AUD                     ║`);
  console.log(`║  Keys:     ${!!(KRAKEN_API_KEY&&KRAKEN_API_SECRET)?'✅':'❌'}                         ║`);
  console.log(`║  AI:       ${!!(process.env.ANTHROPIC_API_KEY)?'✅':'❌'}                         ║`);
  console.log(`║  Telegram: ${!!(TELEGRAM_TOKEN&&TELEGRAM_CHAT_ID)?'✅':'❌'}                         ║`);
  console.log('╚════════════════════════════════════════╝');
  console.log('');
  setTimeout(registerTelegramWebhook, 3000);
});

module.exports = app;
