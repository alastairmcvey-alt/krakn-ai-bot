/**
 * KRAKN·AI — Trading Bot Backend Server v2.6
 * =============================================
 * Fixed AUD ticker, balance-aware AI signals, Telegram two-way chat
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

// ─── AUD Pairs — fetch one at a time to avoid failures ────────
// Kraken uses XXBT not XBT internally, and not all AUD pairs exist
const AUD_PAIRS = ['XBTAUD','ETHAUD','XRPAUD','ADAAUD','LTCAUD','SOLAUD','DOTAUD','LINKAUD'];

const PAIR_DISPLAY = {
  'XBTAUD':'BTC/AUD','ETHAUD':'ETH/AUD','XRPAUD':'XRP/AUD','ADAAUD':'ADA/AUD',
  'LTCAUD':'LTC/AUD','SOLAUD':'SOL/AUD','DOTAUD':'DOT/AUD','LINKAUD':'LINK/AUD'
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

// ─── Price Alerts ──────────────────────────────────────────────
let priceAlerts = [];

// ─── Kraken Helpers ────────────────────────────────────────────
function getKrakenSignature(urlPath, data, secret, nonce) {
  const message       = querystring.stringify(data);
  const secret_buffer = Buffer.from(secret, 'base64');
  const hash          = crypto.createHash('sha256');
  const hmac          = crypto.createHmac('sha512', secret_buffer);
  const hash_digest   = hash.update(nonce + message).digest('binary');
  return hmac.update(urlPath + hash_digest, 'binary').digest('base64');
}

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
        'User-Agent': 'KRAKN-AI-Bot/2.5'
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

function krakenPublicRequest(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const query   = querystring.stringify(params);
    const path    = `/0/public/${endpoint}${query ? '?' + query : ''}`;
    const options = {
      hostname: KRAKEN_HOST, port: 443, path, method: 'GET',
      headers: { 'User-Agent': 'KRAKN-AI-Bot/2.5' }
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

// Fetch a single pair safely — returns null if pair doesn't exist
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

// ─── Auth ──────────────────────────────────────────────────────
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

// ─── Telegram ──────────────────────────────────────────────────
async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[TELEGRAM] Not configured');
    return { ok: false, error: 'Not configured' };
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
    req.on('error', (e) => { console.error('[TELEGRAM ERROR]', e.message); resolve({ ok: false, error: e.message }); });
    req.write(body);
    req.end();
  });
}

// ─── AI Call Helper ────────────────────────────────────────────
async function callClaude(prompt, maxTokens = 400) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    })
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
        messages: [{ role: 'user', content: 'Search for the latest cryptocurrency market news from the last 2 hours. Focus on Bitcoin, Ethereum, Solana, XRP price movements and major events. Return a brief 2-3 sentence summary.' }]
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
    // Get prices for watched pairs
    const marketData = [];
    for (const pair of advisorSettings.pairs) {
      const ticker = await fetchSingleTicker(pair);
      if (!ticker) continue;

      // Get RSI
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
        const ag  = gains.reduce((a,b)=>a+b,0)/gains.length;
        const al  = losses.reduce((a,b)=>a+b,0)/losses.length;
        rsi = Math.round(100 - (100/(1+(al===0?100:ag/al))));
      } catch(e) {}

      marketData.push({ pair, displayPair: PAIR_DISPLAY[pair]||pair, ...ticker, rsi });
    }

    if (!marketData.length) { console.log('[ADVISOR] No market data'); return; }

    // Get balance for context
    let balanceContext = '';
    if (KRAKEN_API_KEY && KRAKEN_API_SECRET) {
      try {
        const bal = await krakenPrivateRequest('Balance');
        const audBal = parseFloat(bal['ZAUD'] || bal['AUD'] || 0);
        if (audBal > 0) balanceContext = `\nInvestor's available AUD balance: $${audBal.toFixed(2)} AUD`;
      } catch(e) {}
    }

    // Get news
    const newsContext = advisorSettings.includeNews ? await fetchCryptoNews() : '';

    // Build market summary
    const marketSummary = marketData.map(d =>
      `${d.displayPair}: $${d.price.toLocaleString('en-AU')} AUD (${d.change24h > 0 ? '+' : ''}${d.change24h}% 24h, RSI: ${d.rsi}, High: $${d.high.toLocaleString('en-AU')}, Low: $${d.low.toLocaleString('en-AU')})`
    ).join('\n');

    const sydneyTime = new Date().toLocaleString('en-AU', { timeZone:'Australia/Sydney', dateStyle:'short', timeStyle:'short' });

    const prompt = `You are an expert crypto trading advisor for an Australian retail investor.

IMPORTANT: All prices below are ALREADY in Australian Dollars (AUD) — they come directly from Kraken's AUD trading pairs. Do NOT convert from USD. Do NOT mention currency differences or that prices "seem high compared to USD". Just analyse the AUD prices as-is and give trading advice.

CURRENT AUD MARKET DATA:
${marketSummary}
${balanceContext}
${newsContext ? `\nLATEST NEWS:\n${newsContext}` : ''}

Give clear actionable trading advice. For each coin:
- BUY / SELL / HOLD recommendation
- Confidence %
- One sentence reason focused on technicals and market conditions — no mention of currency conversion
- If BUY/SELL and balance is known: suggest a specific AUD dollar amount to trade

Format EXACTLY like this:
🤖 <b>KRAKN·AI Market Update</b>
⏰ ${sydneyTime} AEST

Then for each coin:
[price emoji] <b>[PAIR]</b> — $[price] AUD
[action emoji] <b>[BUY/SELL/HOLD]</b> [confidence]% — [reason]${balanceContext ? '\n💰 Suggested: $[amount] AUD' : ''}

Use 🟢 BUY, 🔴 SELL, 🟡 HOLD. Use 📈 if up, 📉 if down.
${newsContext ? '\n📰 <b>NEWS:</b> [one sentence]' : ''}

Only include coins above ${advisorSettings.minConfidence}% confidence. If none qualify, say "No strong signals right now — markets uncertain."`;

    const advice = await callClaude(prompt, 700);
    if (advice) {
      await sendTelegram(advice);
      console.log('[ADVISOR] Telegram sent');
    }

    // ── Check for strong BUY opportunities and prompt user ────
    await checkBuyOpportunities(marketData);

  } catch(err) {
    console.error('[ADVISOR ERROR]', err.message);
  }
}

// ─── Check for Buy Opportunities ──────────────────────────────
async function checkBuyOpportunities(marketData) {
  try {
    // Get AUD cash balance
    let audCash = 0;
    if (KRAKEN_API_KEY && KRAKEN_API_SECRET) {
      const bal = await krakenPrivateRequest('Balance');
      audCash   = parseFloat(bal['ZAUD'] || bal['AUD'] || 0);
    }

    if (audCash < 10) return; // need at least $10 to buy

    // Find strongest BUY signal
    let bestOpportunity = null;
    for (const d of marketData) {
      if (d.rsi < 30) {
        // Strong oversold signal
        const confidence = Math.min(95, 60 + (30 - d.rsi) * 2);
        if (confidence >= advisorSettings.minConfidence) {
          if (!bestOpportunity || confidence > bestOpportunity.confidence) {
            bestOpportunity = { ...d, confidence };
          }
        }
      }
    }

    if (!bestOpportunity) return;

    // Suggest conservative amount — 25% of cash
    const suggestedAUD = Math.min(audCash * 0.25, audCash - 10);
    if (suggestedAUD < 10) return;

    const volume = (suggestedAUD / bestOpportunity.price).toFixed(8);

    // Store as pending opportunity
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

    // Send buy prompt to Telegram
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

// ─── Alert Checker ─────────────────────────────────────────────
async function checkPriceAlerts() {
  const active = priceAlerts.filter(a => !a.triggered);
  if (!active.length) return;
  for (const alert of active) {
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
      const dp          = PAIR_DISPLAY[alert.pair] || alert.pair;
      const emoji       = alert.condition === 'above' ? '🚀' : '📉';
      const sydneyTime  = new Date().toLocaleString('en-AU', { timeZone:'Australia/Sydney', dateStyle:'short', timeStyle:'short' });
      await sendTelegram(
        `${emoji} <b>KRAKN·AI Price Alert!</b>\n\n` +
        `<b>${dp}</b> is now <b>$${currentPrice.toLocaleString('en-AU',{minimumFractionDigits:2})} AUD</b>\n` +
        `Alert: Price ${alert.condition} $${alert.targetPrice.toLocaleString('en-AU',{minimumFractionDigits:2})} AUD\n\n` +
        `⏰ ${sydneyTime} AEST`
      );
    }
  }
}

setInterval(checkPriceAlerts, 60000);
scheduleAdvisor();
setTimeout(() => { if (advisorSettings.enabled) runAdvisor(); }, 15000);

// ══════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({
    status: 'online', version: '2.5',
    keysConfigured: !!(KRAKEN_API_KEY && KRAKEN_API_SECRET),
    aiConfigured: !!(process.env.ANTHROPIC_API_KEY),
    telegramConfigured: !!(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID),
    advisorEnabled: advisorSettings.enabled,
    advisorInterval: advisorSettings.intervalHours,
    currency: 'AUD',
    timestamp: new Date().toISOString()
  });
});

// ─── Ticker — fetch each pair individually so failures don't break others ──
app.get('/api/ticker', async (req, res) => {
  try {
    const requestedPairs = (req.query.pairs || AUD_PAIRS.join(',')).split(',');
    const tickers = {};
    // Fetch all pairs in parallel
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

// ─── AI Signal with balance context ───────────────────────────
app.post('/api/ai/signal', requireAuth, async (req, res) => {
  try {
    const { pair, price, change24h, balanceAUD } = req.body;
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not configured' });

    const displayPair = PAIR_DISPLAY[pair] || pair;

    // Get RSI for better signal
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
      ? `\nThe investor currently has $${parseFloat(balanceAUD).toFixed(2)} AUD available to trade.`
      : '';

    const prompt = `You are a crypto trading AI for an Australian retail investor.

IMPORTANT: These prices are ALREADY in Australian Dollars (AUD) — they come directly from the Kraken AUD trading pairs (e.g. XBTAUD, ETHAUD). Do NOT convert from USD. Do NOT mention any price difference or conversion. Just use these AUD prices as-is.

Analyse ${displayPair} at $${parseFloat(price).toFixed(2)} AUD (${change24h > 0 ? '+' : ''}${change24h}% 24h, RSI: ${rsi}).${balanceNote}

Give a clear buy/sell/hold recommendation. Your reason should be concise, beginner-friendly, and focused on the technical signal and market conditions — do NOT mention currency conversion or price differences between AUD and USD.

Return ONLY this JSON (no markdown, no extra text):
{
  "action": "BUY",
  "confidence": 72,
  "reason": "Brief 1-2 sentence beginner-friendly reason focused on technicals and market conditions only",
  "support": 150000,
  "resistance": 165000,
  "risk": "Medium",
  "rsi": ${rsi},
  "rsi_signal": "Neutral",
  "macd": "Bullish",
  "trend": "Uptrend",
  "suggestedAmountAUD": ${balanceAUD && balanceAUD > 0 ? 'suggested dollar amount as a number based on balance and risk' : 'null'},
  "suggestedPct": ${balanceAUD && balanceAUD > 0 ? 'suggested percentage of balance as a number e.g. 25' : 'null'}
}

For suggestedAmountAUD: be conservative. Suggest 10-30% of available balance for medium confidence, up to 40% for high confidence BUY signals. Never suggest more than 50% on a single trade. Return null if no balance provided or action is HOLD.`;

    const text   = await callClaude(prompt, 400);
    const clean  = text.replace(/```json|```/g, '').trim();
    const signal = JSON.parse(clean);
    res.json({ success: true, data: signal });
  } catch (err) {
    console.error('[AI SIGNAL ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Advisor Settings ──────────────────────────────────────────
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
  res.json({ success: true, message: 'Running analysis — check Telegram in ~30 seconds!' });
  runAdvisor();
});

// ─── Alerts ────────────────────────────────────────────────────
app.get('/api/alerts', requireAuth, (req, res) => {
  res.json({ success: true, data: priceAlerts });
});

app.post('/api/alerts', requireAuth, async (req, res) => {
  const { pair, targetPrice, condition } = req.body;
  if (!pair || !targetPrice || !condition) return res.status(400).json({ error: 'pair, targetPrice and condition required' });
  const alert = { id: Date.now().toString(), pair, targetPrice: parseFloat(targetPrice), condition, triggered: false, createdAt: new Date().toISOString() };
  priceAlerts.push(alert);
  const dp = PAIR_DISPLAY[pair] || pair;
  await sendTelegram(`🔔 <b>Alert Set!</b>\n\n<b>${dp}</b> — notify when ${condition} <b>$${parseFloat(targetPrice).toLocaleString('en-AU',{minimumFractionDigits:2})} AUD</b>`);
  res.json({ success: true, data: alert });
});

app.delete('/api/alerts/:id', requireAuth, (req, res) => {
  const before = priceAlerts.length;
  priceAlerts  = priceAlerts.filter(a => a.id !== req.params.id);
  if (priceAlerts.length < before) res.json({ success: true });
  else res.status(404).json({ error: 'Alert not found' });
});

// ─── Telegram Test ─────────────────────────────────────────────
app.post('/api/telegram/test', requireAuth, async (req, res) => {
  try {
    const result = await sendTelegram(
      '🤖 <b>KRAKN·AI v2.5 Connected!</b>\n\n' +
      '✅ Telegram notifications working!\n\n' +
      'You will receive:\n' +
      '📊 Hourly AI market analysis\n' +
      '💰 Balance-aware trade suggestions\n' +
      '🔔 Price alerts\n' +
      '📰 Latest crypto news\n\n' +
      '🇦🇺 All prices in AUD'
    );
    if (result && result.ok) res.json({ success: true, message: 'Test sent!' });
    else res.status(500).json({ error: 'Telegram error: ' + JSON.stringify(result) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Orders ────────────────────────────────────────────────────
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
    res.json({ success: true, data: { txid:result.txid, description:result.descr, message: validate?'Validated (not placed)':'Order placed!' } });
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

// ─── Auto-Sell Bot ─────────────────────────────────────────────
// Watches ALL coins you hold and auto-sells a % when signal triggers
let botConfig = {
  riskLevel:      'conservative',
  sellPct:        25,          // sell this % of holdings when signal triggers
  confidenceMin:  75,          // minimum RSI confidence to trigger sell
  checkInterval:  60,          // seconds between checks
};
let botState = {
  running:      false,
  lastCheck:    null,
  lastSell:     null,
  sellsCount:   0,
  lastSignals:  {},            // { pair: { action, confidence, rsi } }
};

app.get('/api/bot/config',  requireAuth, (req, res) => res.json({ success:true, data:{...botConfig, state:botState} }));
app.post('/api/bot/config', requireAuth, (req, res) => {
  botConfig = { ...botConfig, ...req.body };
  res.json({ success:true, data:botConfig });
});
app.get('/api/bot/status', requireAuth, (req, res) => res.json({ success:true, data:botState }));

app.post('/api/bot/start', requireAuth, requireKeys, (req, res) => {
  if (botState.running) return res.json({ success:true, message:'Already running' });
  botState.running = true;
  console.log('[AUTO-SELL BOT] Started');
  sendTelegram(
    '🤖 <b>KRAKN·AI Auto-Sell Bot Started!</b>\n\n' +
    `Watching ALL your holdings every ${botConfig.checkInterval} seconds.\n` +
    `Will auto-sell <b>${botConfig.sellPct}%</b> of any coin when RSI signals overbought.\n` +
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
    try {
      await runAutoSellCheck();
    } catch(e) {
      console.error('[AUTO-SELL BOT ERROR]', e.message);
    }
    await new Promise(r => setTimeout(r, botConfig.checkInterval * 1000));
  }
}

async function runAutoSellCheck() {
  botState.lastCheck = new Date().toISOString();
  console.log('[AUTO-SELL BOT] Checking all holdings...');

  // 1. Get current balance — only check coins we actually hold
  let balance;
  try {
    balance = await krakenPrivateRequest('Balance');
  } catch(e) {
    console.error('[AUTO-SELL BOT] Could not fetch balance:', e.message);
    return;
  }

  // 2. Build list of coins we hold with their AUD pair
  const holdings = [];
  for (const [asset, qty] of Object.entries(balance)) {
    const amount = parseFloat(qty);
    if (amount < 0.000001) continue;
    if (asset === 'ZAUD' || asset === 'AUD') continue; // skip cash

    // Map asset to AUD pair
    const sym  = asset.replace(/^X/, '').replace(/Z$/, '');
    const pair = AUD_PAIRS.find(p => p.replace('AUD','') === sym || p.replace('AUD','') === sym.replace('XBT','BTC').replace('BTC','XBT'));

    if (!pair) continue; // skip if we don't have an AUD pair for this coin
    holdings.push({ asset, sym, qty: amount, pair });
  }

  if (!holdings.length) {
    console.log('[AUTO-SELL BOT] No holdings found to check');
    return;
  }

  console.log(`[AUTO-SELL BOT] Checking ${holdings.length} holdings: ${holdings.map(h=>h.sym).join(', ')}`);

  // 3. Check RSI signal for each holding
  for (const holding of holdings) {
    try {
      const ticker = await fetchSingleTicker(holding.pair);
      if (!ticker) continue;

      const signal = await computeRSIForPair(holding.pair);
      botState.lastSignals[holding.pair] = { ...signal, price: ticker.price, checkedAt: new Date().toISOString() };

      const dp = PAIR_DISPLAY[holding.pair] || holding.pair;
      console.log(`[AUTO-SELL BOT] ${dp} — RSI: ${signal.rsi} | Signal: ${signal.action} | Confidence: ${signal.confidence}%`);

      // 4. Only sell if signal is strong enough
      if (signal.action !== 'SELL') continue;
      if (signal.confidence < botConfig.confidenceMin) {
        console.log(`[AUTO-SELL BOT] ${dp} sell signal but confidence ${signal.confidence}% < min ${botConfig.confidenceMin}% — skipping`);
        continue;
      }

      // 5. Calculate sell volume (% of holdings)
      const sellQty    = (holding.qty * (botConfig.sellPct / 100));
      const sellVolume = sellQty.toFixed(8);
      const sellValueAUD = (sellQty * ticker.price).toFixed(2);

      // 6. Send warning Telegram BEFORE selling
      await sendTelegram(
        `⚠️ <b>AUTO-SELL TRIGGERED!</b>\n\n` +
        `<b>${dp}</b>\n` +
        `RSI: ${signal.rsi} (Overbought) | Confidence: ${signal.confidence}%\n` +
        `Current price: $${ticker.price.toLocaleString('en-AU')} AUD\n\n` +
        `Selling <b>${botConfig.sellPct}%</b> of your ${holding.sym}\n` +
        `Amount: ${sellVolume} ${holding.sym} (≈ $${sellValueAUD} AUD)\n\n` +
        `⏳ Placing order now...`
      );

      // 7. Place the sell order
      try {
        const order = await krakenPrivateRequest('AddOrder', {
          pair:      holding.pair,
          type:      'sell',
          ordertype: 'market',
          volume:    sellVolume,
        });

        botState.lastSell = {
          pair:      holding.pair,
          sym:       holding.sym,
          volume:    sellVolume,
          price:     ticker.price,
          valueAUD:  sellValueAUD,
          txid:      order.txid,
          timestamp: new Date().toISOString()
        };
        botState.sellsCount++;

        const sydneyTime = new Date().toLocaleString('en-AU', { timeZone:'Australia/Sydney', dateStyle:'short', timeStyle:'short' });

        // 8. Confirm sell via Telegram
        await sendTelegram(
          `🔴 <b>AUTO-SELL COMPLETED!</b>\n\n` +
          `<b>${dp}</b>\n` +
          `Sold: ${sellVolume} ${holding.sym}\n` +
          `Price: $${ticker.price.toLocaleString('en-AU')} AUD\n` +
          `Value: ≈ $${sellValueAUD} AUD\n` +
          `TXID: ${order.txid?.join(', ')}\n\n` +
          `RSI was ${signal.rsi} — signal was overbought.\n` +
          `Remaining: ${(holding.qty - parseFloat(sellVolume)).toFixed(8)} ${holding.sym}\n\n` +
          `⏰ ${sydneyTime} AEST`
        );

        console.log(`[AUTO-SELL BOT] ✅ Sold ${sellVolume} ${holding.sym} @ $${ticker.price} AUD`);

      } catch(orderErr) {
        console.error(`[AUTO-SELL BOT] Order failed for ${holding.sym}:`, orderErr.message);
        await sendTelegram(
          `❌ <b>AUTO-SELL FAILED!</b>\n\n` +
          `<b>${dp}</b> — Could not place sell order\n` +
          `Error: ${orderErr.message}\n\n` +
          `Please check the app and sell manually if needed.`
        );
      }

      // Small delay between orders
      await new Promise(r => setTimeout(r, 2000));

    } catch(e) {
      console.error(`[AUTO-SELL BOT] Error checking ${holding.sym}:`, e.message);
    }
  }
}

async function computeRSIForPair(pair) {
  try {
    const ohlc   = await krakenPublicRequest('OHLC', { pair, interval:60 });
    const k      = Object.keys(ohlc).find(k => k !== 'last');
    const closes = ohlc[k].slice(-14).map(c => parseFloat(c[4]));
    const gains = [], losses = [];
    for (let i=1;i<closes.length;i++) {
      const d = closes[i] - closes[i-1];
      gains.push(Math.max(d,0));
      losses.push(Math.max(-d,0));
    }
    const ag  = gains.reduce((a,b)=>a+b,0) / gains.length;
    const al  = losses.reduce((a,b)=>a+b,0) / losses.length;
    const rsi = 100 - (100 / (1 + (al===0 ? 100 : ag/al)));
    let action='HOLD', confidence=50;

    // Only trigger SELL — this bot is sell-only
    if (rsi > 70) {
      action     = 'SELL';
      confidence = Math.min(95, 60 + (rsi - 70) * 2);
    } else if (rsi > 60) {
      // Soft sell signal
      action     = 'SELL';
      confidence = Math.min(70, 50 + (rsi - 60) * 2);
    }

    // Conservative mode requires higher confidence
    if (botConfig.riskLevel === 'conservative') confidence *= 0.85;
    if (botConfig.riskLevel === 'aggressive')   confidence *= 1.10;

    return { action, confidence: Math.min(99, Math.round(confidence)), rsi: Math.round(rsi) };
  } catch {
    return { action:'HOLD', confidence:0, rsi:50 };
  }
}



// ── Server-side formatting helpers ────────────────────────────
function fmtAUDServer(p) {
  if (!p && p !== 0) return '--';
  if (p >= 1000) return 'A$' + p.toLocaleString('en-AU', {maximumFractionDigits:0});
  if (p >= 1)    return 'A$' + parseFloat(p).toFixed(2);
  return 'A$' + parseFloat(p).toFixed(4);
}
function fmtVolume(v) {
  return parseFloat(v) < 0.001 ? parseFloat(v).toFixed(8) : parseFloat(v).toFixed(4);
}

// ══════════════════════════════════════════════════════════════
// TELEGRAM TWO-WAY CHAT
// ══════════════════════════════════════════════════════════════

// ── Pending Buy State ─────────────────────────────────────────
// Stores the last buy opportunity sent to Telegram so YES can execute it
let pendingBuyOpportunity = null;

// ── Conversation history ───────────────────────────────────────
const chatHistory = {};

// Register webhook with Telegram when server starts
async function registerTelegramWebhook() {
  if (!TELEGRAM_TOKEN) return;
  try {
    const serverUrl = process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN;
    if (!serverUrl) { console.log('[TELEGRAM] No public URL found, webhook not registered'); return; }
    const webhookUrl = `https://${serverUrl}/api/telegram/webhook`;
    const body = JSON.stringify({ url: webhookUrl });
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
          try { const r = JSON.parse(data); console.log('[TELEGRAM] Webhook registered:', r.ok ? '✅' : '❌ ' + r.description); }
          catch(e) {}
          resolve();
        });
      });
      req.on('error', () => resolve());
      req.write(body);
      req.end();
    });
  } catch(e) { console.error('[TELEGRAM WEBHOOK ERROR]', e.message); }
}

// Send typing indicator to Telegram
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

// Send message to a specific chat ID
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

// Handle incoming Telegram message with AI
async function handleTelegramMessage(chatId, userMessage, username) {
  // Security: only respond to the configured chat ID
  if (String(chatId) !== String(TELEGRAM_CHAT_ID)) {
    await sendTelegramTo(chatId, '⛔ Unauthorised. This bot is private.');
    return;
  }

  console.log(`[TELEGRAM CHAT] ${username}: ${userMessage}`);

  // Show typing indicator
  await sendTyping(chatId);

  // Handle special commands
  const msg = userMessage.trim().toLowerCase();

  if (msg === '/start' || msg === 'start') {
    await sendTelegramTo(chatId,
      '🤖 <b>KRAKN·AI Assistant</b>\n\n' +
      'Ask me anything about crypto! For example:\n\n' +
      '• "How is BTC looking right now?"\n' +
      '• "Should I buy ETH?"\n' +
      '• "What\'s my portfolio worth?"\n' +
      '• "Run market analysis"\n' +
      '• "What\'s happening in crypto today?"\n' +
      '• "Is now a good time to sell SOL?"\n\n' +
      '💡 When I spot a buy opportunity I\'ll ask if you want to buy.\n' +
      'Just reply <b>YES</b> to confirm or <b>NO</b> to skip.'
    );
    return;
  }

  if (msg === 'run analysis' || msg === '/analysis' || msg === 'analyse' || msg === 'analyze') {
    await sendTelegramTo(chatId, '⏳ Running full market analysis... give me 30 seconds!');
    await runAdvisor();
    return;
  }

  // ── Handle YES — execute pending buy ────────────────────────
  if (msg === 'yes' || msg === 'yes!' || msg === 'y' || msg === '/yes') {
    if (!pendingBuyOpportunity) {
      await sendTelegramTo(chatId, '🤔 No pending buy opportunity — ask me about a coin first!');
      return;
    }

    const opp = pendingBuyOpportunity;
    pendingBuyOpportunity = null; // clear it

    // Check it hasn't expired (10 minutes)
    const age = (Date.now() - opp.timestamp) / 1000 / 60;
    if (age > 10) {
      await sendTelegramTo(chatId, `⏰ That opportunity expired ${Math.round(age)} minutes ago. Ask me again for a fresh signal!`);
      return;
    }

    await sendTelegramTo(chatId,
      `⏳ <b>Placing buy order...</b>\n\n` +
      `Buying ${fmtVolume(opp.volume)} <b>${opp.sym}</b>\n` +
      `≈ ${fmtAUDServer(opp.amountAUD)} AUD at market price`
    );

    try {
      // Get fresh price first
      const ticker = await fetchSingleTicker(opp.pair);
      const freshPrice  = ticker ? ticker.price : opp.price;
      const freshVolume = (opp.amountAUD / freshPrice).toFixed(8);

      const order = await krakenPrivateRequest('AddOrder', {
        pair:      opp.pair,
        type:      'buy',
        ordertype: 'market',
        volume:    freshVolume,
      });

      const valueAUD    = (parseFloat(freshVolume) * freshPrice).toFixed(2);
      const sydneyTime  = new Date().toLocaleString('en-AU', { timeZone:'Australia/Sydney', dateStyle:'short', timeStyle:'short' });

      await sendTelegramTo(chatId,
        `🟢 <b>BUY ORDER PLACED!</b>\n\n` +
        `<b>${opp.displayPair}</b>\n` +
        `Bought: ${freshVolume} ${opp.sym}\n` +
        `Price: ${fmtAUDServer(freshPrice)}\n` +
        `Total: ≈ ${fmtAUDServer(parseFloat(valueAUD))}\n` +
        `TXID: ${order.txid?.join(', ')}\n\n` +
        `⏰ ${sydneyTime} AEST\n\n` +
        `Good luck! 🚀 I'll monitor and alert you when to sell.`
      );

      console.log(`[TELEGRAM BUY] ✅ Bought ${freshVolume} ${opp.sym} @ ${freshPrice} AUD`);

    } catch(orderErr) {
      console.error('[TELEGRAM BUY ERROR]', orderErr.message);
      await sendTelegramTo(chatId,
        `❌ <b>BUY ORDER FAILED</b>\n\n` +
        `Error: ${orderErr.message}\n\n` +
        `Please check the app and try manually.`
      );
    }
    return;
  }

  // ── Handle NO — cancel pending buy ──────────────────────────
  if (msg === 'no' || msg === 'no!' || msg === 'n' || msg === '/no') {
    if (pendingBuyOpportunity) {
      const opp = pendingBuyOpportunity;
      pendingBuyOpportunity = null;
      await sendTelegramTo(chatId, `👍 Skipped ${opp.sym} buy. I'll keep watching the markets!`);
    } else {
      await sendTelegramTo(chatId, '👍 No problem!');
    }
    return;
  }

  // Get live market data to include in context
  let marketContext = '';
  try {
    const marketLines = [];
    for (const pair of ['XBTAUD','ETHAUD','SOLAUD','XRPAUD','ADAAUD']) {
      const ticker = await fetchSingleTicker(pair);
      if (ticker) {
        const dp = PAIR_DISPLAY[pair] || pair;
        marketLines.push(`${dp}: $${ticker.price.toLocaleString('en-AU')} AUD (${ticker.change24h > 0 ? '+' : ''}${ticker.change24h}% 24h)`);
      }
    }
    if (marketLines.length) marketContext = '\nCURRENT AUD PRICES:\n' + marketLines.join('\n');
  } catch(e) {}

  // Get balance context
  let balanceContext = '';
  try {
    if (KRAKEN_API_KEY && KRAKEN_API_SECRET) {
      const bal    = await krakenPrivateRequest('Balance');
      const audBal = parseFloat(bal['ZAUD'] || bal['AUD'] || 0);
      const lines  = [];
      if (audBal > 0) lines.push(`AUD Cash: $${audBal.toFixed(2)}`);
      for (const [asset, qty] of Object.entries(bal)) {
        if (asset === 'ZAUD' || asset === 'AUD') continue;
        if (parseFloat(qty) > 0.000001) {
          const sym  = asset.replace(/^X/,'').replace(/Z$/,'').replace('XBT','BTC');
          const pair = Object.keys(PAIR_DISPLAY).find(p => p.includes(sym === 'BTC' ? 'XBT' : sym));
          const ticker = pair ? await fetchSingleTicker(pair) : null;
          const val    = ticker ? (parseFloat(qty) * ticker.price).toFixed(2) : '?';
          lines.push(`${sym}: ${parseFloat(qty).toFixed(6)} (≈ $${val} AUD)`);
        }
      }
      if (lines.length) balanceContext = '\nYOUR PORTFOLIO:\n' + lines.join('\n');
    }
  } catch(e) {}

  const sydneyTime = new Date().toLocaleString('en-AU', { timeZone:'Australia/Sydney', dateStyle:'short', timeStyle:'short' });

  // Build conversation history (keep last 6 messages for context)
  if (!chatHistory[chatId]) chatHistory[chatId] = [];
  chatHistory[chatId].push({ role: 'user', content: userMessage });
  if (chatHistory[chatId].length > 12) chatHistory[chatId] = chatHistory[chatId].slice(-12);

  const systemPrompt = `You are KRAKN·AI, a personal cryptocurrency trading assistant for an Australian investor. You are helpful, concise, and speak plainly — no jargon unless asked.

IMPORTANT ABOUT PRICES: All prices are in Australian Dollars (AUD) directly from Kraken's AUD trading pairs. Do NOT convert from USD. Do NOT mention price differences between AUD and USD. Just use these AUD prices as-is.
${marketContext}
${balanceContext}

Current time: ${sydneyTime} AEST

Guidelines:
- Keep responses concise and easy to read in Telegram (use line breaks, emojis for readability)
- Give clear actionable advice when asked about trading
- Be honest about uncertainty — crypto is volatile
- When suggesting trades, be conservative with position sizing
- You can answer general crypto questions, news questions, strategy questions
- Format nicely for Telegram using HTML: <b>bold</b> for important things
- Never give financial advice as a guarantee — always note the risk
- If asked about a specific coin, check the live price data above first`;

  try {
    // Keep typing going for longer responses
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

    const data   = await response.json();
    const reply  = data.content?.map(c => c.text || '').join('') || 'Sorry, I had trouble processing that.';

    // Add assistant reply to history
    chatHistory[chatId].push({ role: 'assistant', content: reply });

    await sendTelegramTo(chatId, reply);
    console.log(`[TELEGRAM CHAT] Replied to ${username}`);

  } catch(err) {
    clearInterval && clearInterval();
    console.error('[TELEGRAM CHAT ERROR]', err.message);
    await sendTelegramTo(chatId, '❌ Sorry, I had an error. Try again in a moment.');
  }
}

// ─── Telegram Webhook Endpoint ─────────────────────────────────
app.post('/api/telegram/webhook', async (req, res) => {
  // Always respond 200 immediately so Telegram doesn't retry
  res.sendStatus(200);

  try {
    const update  = req.body;
    const message = update.message || update.edited_message;
    if (!message || !message.text) return;

    const chatId   = message.chat.id;
    const text     = message.text;
    const username = message.from?.username || message.from?.first_name || 'User';

    // Handle in background so we don't block
    handleTelegramMessage(chatId, text, username).catch(e => console.error('[WEBHOOK ERROR]', e.message));
  } catch(e) {
    console.error('[WEBHOOK PARSE ERROR]', e.message);
  }
});

// ─── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║        KRAKN·AI Bot Server v2.5        ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  Port:     ${PORT}                         ║`);
  console.log(`║  Currency: 🇦🇺 AUD                     ║`);
  console.log(`║  Keys:     ${!!(KRAKEN_API_KEY&&KRAKEN_API_SECRET)?'✅':'❌'}                         ║`);
  console.log(`║  AI:       ${!!(process.env.ANTHROPIC_API_KEY)?'✅':'❌'}                         ║`);
  console.log(`║  Telegram: ${!!(TELEGRAM_TOKEN&&TELEGRAM_CHAT_ID)?'✅':'❌'}                         ║`);
  console.log('╚════════════════════════════════════════╝');
  console.log('');
  // Register Telegram webhook
  setTimeout(registerTelegramWebhook, 3000);
});

module.exports = app;
