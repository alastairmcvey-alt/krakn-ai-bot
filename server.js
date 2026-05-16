/**
 * KRAKN·AI — Trading Bot Backend Server v2.5
 * =============================================
 * Fixed AUD ticker, balance-aware AI signals, Telegram advisor
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

    const prompt = `You are an expert crypto trading advisor for an Australian retail investor. All prices are in AUD.

MARKET DATA:
${marketSummary}
${balanceContext}
${newsContext ? `\nLATEST NEWS:\n${newsContext}` : ''}

Give clear actionable trading advice. For each coin provide:
- BUY / SELL / HOLD recommendation
- Confidence %
- One sentence reason
- If BUY/SELL and balance is known: suggest a specific dollar amount to trade

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
  } catch(err) {
    console.error('[ADVISOR ERROR]', err.message);
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

    const prompt = `You are a crypto trading AI for an Australian retail investor. All prices in AUD.

Analyse ${displayPair} at $${parseFloat(price).toFixed(2)} AUD (${change24h > 0 ? '+' : ''}${change24h}% 24h, RSI: ${rsi}).${balanceNote}

Return ONLY this JSON (no markdown, no extra text):
{
  "action": "BUY",
  "confidence": 72,
  "reason": "Brief 1-2 sentence beginner-friendly reason",
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

For suggestedAmountAUD: be conservative, suggest 10-30% of available balance for medium confidence, up to 40% for high confidence BUY signals. Never suggest more than 50% of balance on a single trade. Return null if no balance provided or action is HOLD.`;

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

// ─── Bot ───────────────────────────────────────────────────────
let botConfig = { riskLevel:'conservative', maxTradeAUD:150, confidenceMin:75, pairs:['XBTAUD'] };
let botState  = { running:false, lastSignal:null, lastTrade:null, tradesCount:0 };

app.get('/api/bot/config',  requireAuth, (req, res) => res.json({ success:true, data:{...botConfig,state:botState} }));
app.post('/api/bot/config', requireAuth, (req, res) => { botConfig={...botConfig,...req.body}; res.json({success:true,data:botConfig}); });
app.get('/api/bot/status',  requireAuth, (req, res) => res.json({ success:true, data:botState }));
app.post('/api/bot/start',  requireAuth, requireKeys, (req, res) => {
  if (botState.running) return res.json({success:true,message:'Already running'});
  botState.running = true;
  sendTelegram('🤖 <b>KRAKN·AI Auto-Trading Started!</b>');
  startBotLoop();
  res.json({success:true,message:'Bot started'});
});
app.post('/api/bot/stop', requireAuth, (req, res) => {
  botState.running = false;
  sendTelegram('⏸ <b>KRAKN·AI Auto-Trading Paused</b>');
  res.json({success:true,message:'Bot stopped'});
});

async function startBotLoop() {
  while (botState.running) {
    try { for (const pair of botConfig.pairs) await runBotPair(pair); }
    catch(e) { console.error('[BOT]', e.message); }
    await new Promise(r => setTimeout(r, 60000));
  }
}

async function runBotPair(pair) {
  const ticker = await fetchSingleTicker(pair);
  if (!ticker) return;
  const signal = await computeRSI(pair);
  botState.lastSignal = { pair, signal, price:ticker.price, timestamp: new Date().toISOString() };
  if (signal.confidence < botConfig.confidenceMin) return;
  if (signal.action === 'BUY' || signal.action === 'SELL') {
    const type   = signal.action.toLowerCase();
    const volume = (botConfig.maxTradeAUD / ticker.price).toFixed(8);
    try {
      const order = await krakenPrivateRequest('AddOrder', { pair, type, ordertype:'market', volume });
      botState.lastTrade = { pair, type, volume, price:ticker.price, txid:order.txid, timestamp:new Date().toISOString() };
      botState.tradesCount++;
      const dp = PAIR_DISPLAY[pair]||pair;
      sendTelegram(`${type==='buy'?'🟢':'🔴'} <b>Bot Trade!</b>\n${type.toUpperCase()} ${volume} <b>${dp}</b>\n$${ticker.price.toLocaleString('en-AU')} AUD`);
    } catch(e) { console.error('[BOT ORDER]', e.message); }
  }
}

async function computeRSI(pair) {
  try {
    const ohlc   = await krakenPublicRequest('OHLC', { pair, interval:60 });
    const k      = Object.keys(ohlc).find(k => k !== 'last');
    const closes = ohlc[k].slice(-14).map(c => parseFloat(c[4]));
    const gains = [], losses = [];
    for (let i=1;i<closes.length;i++) { const d=closes[i]-closes[i-1]; gains.push(Math.max(d,0)); losses.push(Math.max(-d,0)); }
    const ag  = gains.reduce((a,b)=>a+b,0)/gains.length;
    const al  = losses.reduce((a,b)=>a+b,0)/losses.length;
    const rsi = 100 - (100/(1+(al===0?100:ag/al)));
    let action='HOLD', confidence=50;
    if (rsi<30) { action='BUY'; confidence=Math.min(95,60+(30-rsi)*2); }
    else if (rsi>70) { action='SELL'; confidence=Math.min(95,60+(rsi-70)*2); }
    if (botConfig.riskLevel==='conservative') confidence*=0.85;
    if (botConfig.riskLevel==='aggressive')   confidence*=1.10;
    return { action, confidence:Math.min(99,Math.round(confidence)), rsi:Math.round(rsi) };
  } catch { return { action:'HOLD', confidence:0, rsi:50 }; }
}

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
});

module.exports = app;
