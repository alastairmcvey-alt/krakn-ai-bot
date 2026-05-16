/**
 * KRAKN·AI — Trading Bot Backend Server v2.3
 * =======================================
 * AUD support, multi-coin AI signals, price alerts, Telegram notifications
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');
const querystring = require('querystring');
require('dotenv').config();

const app = express();
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
const TELEGRAM_TOKEN    = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID  = (process.env.TELEGRAM_CHAT_ID  || '').trim();

// ─── AUD Trading Pairs ─────────────────────────────────────────
const AUD_PAIRS = [
  'XBTAUD', 'ETHAUD', 'XRPAUD', 'ADAAUD', 'SOLAUD',
  'LTCAUD', 'DOTAUD', 'LINKAUD', 'UNIAUD', 'MATICAUD'
];

const PAIR_DISPLAY = {
  'XBTAUD':   'BTC/AUD',
  'ETHAUD':   'ETH/AUD',
  'XRPAUD':   'XRP/AUD',
  'ADAAUD':   'ADA/AUD',
  'SOLAUD':   'SOL/AUD',
  'LTCAUD':   'LTC/AUD',
  'DOTAUD':   'DOT/AUD',
  'LINKAUD':  'LINK/AUD',
  'UNIAUD':   'UNI/AUD',
  'MATICAUD': 'MATIC/AUD',
};

// ─── Price Alerts Storage ──────────────────────────────────────
let priceAlerts = [];

// ─── Telegram Notification ─────────────────────────────────────
async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[TELEGRAM] Not configured, skipping');
    return;
  }
  return new Promise((resolve) => {
    const body = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
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
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', (e) => { console.error('[TELEGRAM ERROR]', e.message); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ─── Kraken Signature ──────────────────────────────────────────
function getKrakenSignature(urlPath, data, secret, nonce) {
  const message       = querystring.stringify(data);
  const secret_buffer = Buffer.from(secret, 'base64');
  const hash          = crypto.createHash('sha256');
  const hmac          = crypto.createHmac('sha512', secret_buffer);
  const hash_digest   = hash.update(nonce + message).digest('binary');
  const hmac_digest   = hmac.update(urlPath + hash_digest, 'binary').digest('base64');
  return hmac_digest;
}

// ─── Kraken Private Request ────────────────────────────────────
function krakenPrivateRequest(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const nonce     = Date.now().toString();
    const urlPath   = '/0/private/' + endpoint;
    const data      = { nonce, ...params };
    const signature = getKrakenSignature(urlPath, data, KRAKEN_API_SECRET, nonce);
    const postData  = querystring.stringify(data);

    const options = {
      hostname: KRAKEN_HOST,
      port: 443,
      path: urlPath,
      method: 'POST',
      headers: {
        'API-Key': KRAKEN_API_KEY,
        'API-Sign': signature,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'KRAKN-AI-Bot/2.3'
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
    const query = querystring.stringify(params);
    const path  = `/0/public/${endpoint}${query ? '?' + query : ''}`;
    const options = {
      hostname: KRAKEN_HOST,
      port: 443,
      path,
      method: 'GET',
      headers: { 'User-Agent': 'KRAKN-AI-Bot/2.3' }
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

// ─── Alert Checker (runs every 60 seconds) ────────────────────
async function checkPriceAlerts() {
  const activeAlerts = priceAlerts.filter(a => !a.triggered);
  if (!activeAlerts.length) return;

  try {
    const pairs  = [...new Set(activeAlerts.map(a => a.pair))].join(',');
    const result = await krakenPublicRequest('Ticker', { pair: pairs });

    for (const alert of activeAlerts) {
      const tickerKey = Object.keys(result).find(k =>
        k === alert.pair || k.replace('XXBT','XBT') === alert.pair
      );
      if (!tickerKey) continue;

      const currentPrice = parseFloat(result[tickerKey].c[0]);
      const triggered =
        (alert.condition === 'above' && currentPrice >= alert.targetPrice) ||
        (alert.condition === 'below' && currentPrice <= alert.targetPrice);

      if (triggered) {
        alert.triggered      = true;
        alert.triggeredAt    = new Date().toISOString();
        alert.triggeredPrice = currentPrice;

        const displayPair = PAIR_DISPLAY[alert.pair] || alert.pair;
        const emoji       = alert.condition === 'above' ? '🚀' : '📉';
        const msg = `${emoji} <b>KRAKN·AI Price Alert!</b>\n\n` +
          `<b>${displayPair}</b> is now <b>$${currentPrice.toLocaleString('en-AU', {minimumFractionDigits:2})} AUD</b>\n` +
          `Alert: Price goes ${alert.condition} $${alert.targetPrice.toLocaleString('en-AU', {minimumFractionDigits:2})} AUD\n\n` +
          `⏰ ${new Date().toLocaleString('en-AU', {timeZone:'Australia/Sydney'})} AEST`;

        console.log(`[ALERT TRIGGERED] ${displayPair} ${alert.condition} $${alert.targetPrice}`);
        await sendTelegram(msg);
      }
    }
  } catch (err) {
    console.error('[ALERT CHECK ERROR]', err.message);
  }
}

setInterval(checkPriceAlerts, 60000);

// ══════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ══════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    version: '2.3',
    keysConfigured: !!(KRAKEN_API_KEY && KRAKEN_API_SECRET),
    aiConfigured: !!(process.env.ANTHROPIC_API_KEY),
    telegramConfigured: !!(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID),
    currency: 'AUD',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/ticker', async (req, res) => {
  try {
    const pairs  = req.query.pairs || AUD_PAIRS.join(',');
    const result = await krakenPublicRequest('Ticker', { pair: pairs });
    const tickers = {};
    for (const [krakenPair, data] of Object.entries(result)) {
      const standardPair = Object.keys(PAIR_DISPLAY).find(p =>
        krakenPair === p || krakenPair.replace('XXBT','XBT') === p
      ) || krakenPair;
      tickers[standardPair] = {
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
    }
    res.json({ success: true, data: tickers, currency: 'AUD' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ohlc', async (req, res) => {
  try {
    const { pair = 'XBTAUD', interval = 60 } = req.query;
    const result = await krakenPublicRequest('OHLC', { pair, interval: parseInt(interval) });
    const key    = Object.keys(result).find(k => k !== 'last');
    res.json({ success: true, data: result[key], last: result.last });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orderbook', async (req, res) => {
  try {
    const { pair = 'XBTAUD', count = 10 } = req.query;
    const result = await krakenPublicRequest('Depth', { pair, count: parseInt(count) });
    const key    = Object.keys(result)[0];
    res.json({ success: true, data: result[key] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// PRIVATE ROUTES
// ══════════════════════════════════════════════════════════════

app.get('/api/balance', requireAuth, requireKeys, async (req, res) => {
  try {
    const result   = await krakenPrivateRequest('Balance');
    const balances = {};
    for (const [asset, amount] of Object.entries(result)) {
      if (parseFloat(amount) > 0) balances[asset] = parseFloat(amount);
    }
    res.json({ success: true, data: balances });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orders/open', requireAuth, requireKeys, async (req, res) => {
  try {
    const result = await krakenPrivateRequest('OpenOrders');
    res.json({ success: true, data: result.open || {} });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orders/closed', requireAuth, requireKeys, async (req, res) => {
  try {
    const result = await krakenPrivateRequest('ClosedOrders');
    res.json({ success: true, data: result.closed || {} });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/trades', requireAuth, requireKeys, async (req, res) => {
  try {
    const result = await krakenPrivateRequest('TradesHistory');
    res.json({ success: true, data: result.trades || {} });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── AI Signal ────────────────────────────────────────────────
app.post('/api/ai/signal', requireAuth, async (req, res) => {
  try {
    const { pair, price, change24h } = req.body;
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(400).json({ error: 'ANTHROPIC_API_KEY not configured' });
    }

    const displayPair = PAIR_DISPLAY[pair] || pair;
    const prompt = `You are a crypto trading AI for an Australian investor. Analyse ${displayPair} at $${parseFloat(price).toFixed(2)} AUD (${change24h > 0 ? '+' : ''}${change24h}% 24h). All prices are in Australian Dollars (AUD). Return ONLY this JSON (no markdown): {"action":"BUY","confidence":72,"reason":"Brief beginner-friendly reason","support":150000,"resistance":165000,"risk":"Medium","rsi":54,"rsi_signal":"Neutral","macd":"Bullish","trend":"Uptrend"}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (!data.content || !data.content.length) {
      const errMsg = data.error?.message || JSON.stringify(data);
      return res.status(500).json({ error: 'AI error: ' + errMsg });
    }

    const text   = data.content.map(i => i.text || '').join('');
    const clean  = text.replace(/```json|```/g, '').trim();
    const signal = JSON.parse(clean);
    res.json({ success: true, data: signal });
  } catch (err) {
    console.error('[AI SIGNAL ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Price Alerts ─────────────────────────────────────────────
app.get('/api/alerts', requireAuth, (req, res) => {
  res.json({ success: true, data: priceAlerts });
});

app.post('/api/alerts', requireAuth, async (req, res) => {
  const { pair, targetPrice, condition } = req.body;
  if (!pair || !targetPrice || !condition) {
    return res.status(400).json({ error: 'pair, targetPrice and condition required' });
  }

  const alert = {
    id: Date.now().toString(),
    pair,
    targetPrice: parseFloat(targetPrice),
    condition,
    triggered: false,
    createdAt: new Date().toISOString()
  };

  priceAlerts.push(alert);
  const displayPair = PAIR_DISPLAY[pair] || pair;
  console.log(`[ALERT CREATED] ${displayPair} ${condition} $${targetPrice} AUD`);

  await sendTelegram(`🔔 <b>Price Alert Set!</b>\n\n<b>${displayPair}</b>\nAlert when price goes <b>${condition}</b> <b>$${parseFloat(targetPrice).toLocaleString('en-AU', {minimumFractionDigits:2})} AUD</b>`);
  res.json({ success: true, data: alert });
});

app.delete('/api/alerts/:id', requireAuth, (req, res) => {
  const before = priceAlerts.length;
  priceAlerts  = priceAlerts.filter(a => a.id !== req.params.id);
  if (priceAlerts.length < before) res.json({ success: true, message: 'Alert deleted' });
  else res.status(404).json({ error: 'Alert not found' });
});

app.delete('/api/alerts', requireAuth, (req, res) => {
  priceAlerts = [];
  res.json({ success: true, message: 'All alerts cleared' });
});

// ─── Telegram Test ────────────────────────────────────────────
app.post('/api/telegram/test', requireAuth, async (req, res) => {
  try {
    await sendTelegram('🤖 <b>KRAKN·AI</b> — Telegram is connected!\n\nYou will receive:\n🔔 Price alerts\n🟢 Buy orders\n🔴 Sell orders\n🤖 Bot trade notifications');
    res.json({ success: true, message: 'Test message sent to Telegram!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Place Order ───────────────────────────────────────────────
app.post('/api/order/place', requireAuth, requireKeys, async (req, res) => {
  try {
    const { pair, type, ordertype, volume, price, leverage, validate } = req.body;
    if (!pair || !type || !ordertype || !volume) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const params = { pair, type, ordertype, volume: String(volume) };
    if (price)    params.price    = String(price);
    if (leverage) params.leverage = String(leverage);
    if (validate) params.validate = true;

    const result = await krakenPrivateRequest('AddOrder', params);

    if (!validate) {
      const displayPair = PAIR_DISPLAY[pair] || pair;
      const emoji = type === 'buy' ? '🟢' : '🔴';
      sendTelegram(`${emoji} <b>Order Placed!</b>\n\n${type.toUpperCase()} ${volume} <b>${displayPair}</b>\nType: ${ordertype}\nTXID: ${result.txid?.join(', ')}`);
    }

    res.json({
      success: true,
      data: {
        txid: result.txid,
        description: result.descr,
        message: validate ? 'Order validated (not placed)' : 'Order placed successfully'
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/order/cancel', requireAuth, requireKeys, async (req, res) => {
  try {
    const { txid } = req.body;
    if (!txid) return res.status(400).json({ error: 'txid required' });
    const result = await krakenPrivateRequest('CancelOrder', { txid });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/order/cancel-all', requireAuth, requireKeys, async (req, res) => {
  try {
    const result = await krakenPrivateRequest('CancelAll');
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// BOT AUTO-TRADING
// ══════════════════════════════════════════════════════════════
let botConfig = {
  enabled:       false,
  riskLevel:     'conservative',
  maxTradeAUD:   150,
  takeProfitPct: 5,
  stopLossPct:   3,
  pairs:         ['XBTAUD'],
  confidenceMin: 75,
};

let botState = {
  running:     false,
  lastSignal:  null,
  lastTrade:   null,
  tradesCount: 0,
  profitAUD:   0,
};

app.get('/api/bot/config',  requireAuth, (req, res) => res.json({ success: true, data: { ...botConfig, state: botState } }));
app.post('/api/bot/config', requireAuth, (req, res) => { botConfig = { ...botConfig, ...req.body }; res.json({ success: true, data: botConfig }); });
app.get('/api/bot/status',  requireAuth, (req, res) => res.json({ success: true, data: botState }));

app.post('/api/bot/start', requireAuth, requireKeys, (req, res) => {
  if (botState.running) return res.json({ success: true, message: 'Bot already running' });
  botState.running = true;
  sendTelegram('🤖 <b>KRAKN·AI Bot Started!</b>\nAuto-trading is now active.');
  startBotLoop();
  res.json({ success: true, message: 'Bot started' });
});

app.post('/api/bot/stop', requireAuth, (req, res) => {
  botState.running = false;
  sendTelegram('⏸ <b>KRAKN·AI Bot Paused</b>\nAuto-trading has been stopped.');
  res.json({ success: true, message: 'Bot stopped' });
});

async function startBotLoop() {
  while (botState.running) {
    try {
      for (const pair of botConfig.pairs) await runBotForPair(pair);
    } catch (err) { console.error('[BOT ERROR]', err.message); }
    await sleep(60000);
  }
}

async function runBotForPair(pair) {
  const tickerResult = await krakenPublicRequest('Ticker', { pair });
  const key          = Object.keys(tickerResult)[0];
  const price        = parseFloat(tickerResult[key].c[0]);
  const open         = parseFloat(tickerResult[key].o);
  const change24h    = ((price - open) / open * 100).toFixed(2);
  const signal       = await computeSignal(pair, price, parseFloat(change24h));

  botState.lastSignal = { pair, signal, price, timestamp: new Date().toISOString() };
  console.log(`[BOT] ${pair} A$${price} ${signal.action} ${signal.confidence}%`);

  if (signal.confidence < botConfig.confidenceMin) return;

  const volume = (botConfig.maxTradeAUD / price).toFixed(8);
  if (signal.action === 'BUY' || signal.action === 'SELL') {
    const type = signal.action.toLowerCase();
    try {
      const order = await krakenPrivateRequest('AddOrder', { pair, type, ordertype: 'market', volume });
      botState.lastTrade  = { pair, type, volume, price, txid: order.txid, timestamp: new Date().toISOString() };
      botState.tradesCount++;
      const displayPair = PAIR_DISPLAY[pair] || pair;
      const emoji = type === 'buy' ? '🟢' : '🔴';
      sendTelegram(`${emoji} <b>Bot Trade!</b>\n${type.toUpperCase()} ${volume} <b>${displayPair}</b>\nPrice: $${price.toLocaleString('en-AU')} AUD\nRSI: ${signal.rsi} | Confidence: ${signal.confidence}%`);
    } catch (err) { console.error(`[BOT] Order failed: ${err.message}`); }
  }
}

async function computeSignal(pair, currentPrice, change24h) {
  try {
    const ohlcResult = await krakenPublicRequest('OHLC', { pair, interval: 60 });
    const key        = Object.keys(ohlcResult).find(k => k !== 'last');
    const candles    = ohlcResult[key].slice(-14);
    const closes     = candles.map(c => parseFloat(c[4]));
    const gains = [], losses = [];
    for (let i = 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      gains.push(Math.max(diff, 0));
      losses.push(Math.max(-diff, 0));
    }
    const avgGain = gains.reduce((a, b) => a + b, 0) / gains.length;
    const avgLoss = losses.reduce((a, b) => a + b, 0) / losses.length;
    const rs  = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));
    let action = 'HOLD', confidence = 50;
    if (rsi < 30)                        { action = 'BUY';  confidence = Math.min(95, 60 + (30 - rsi) * 2); }
    else if (rsi > 70)                   { action = 'SELL'; confidence = Math.min(95, 60 + (rsi - 70) * 2); }
    else if (rsi < 45 && change24h > 0) { action = 'BUY';  confidence = 55 + Math.abs(change24h); }
    else if (rsi > 55 && change24h < 0) { action = 'SELL'; confidence = 55 + Math.abs(change24h); }
    if (botConfig.riskLevel === 'conservative') confidence *= 0.85;
    if (botConfig.riskLevel === 'aggressive')   confidence *= 1.10;
    return { action, confidence: Math.min(99, Math.round(confidence)), rsi: Math.round(rsi) };
  } catch { return { action: 'HOLD', confidence: 0, rsi: 50 }; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.listen(PORT, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════╗');
  console.log('║        KRAKN·AI Bot Server v2.3       ║');
  console.log('╠═══════════════════════════════════════╣');
  console.log(`║  Running on http://localhost:${PORT}      ║`);
  console.log(`║  Currency:        🇦🇺 AUD              ║`);
  console.log(`║  Keys configured: ${!!(KRAKEN_API_KEY && KRAKEN_API_SECRET) ? '✅ YES          ║' : '❌ NO           ║'}`);
  console.log(`║  AI configured:   ${!!(process.env.ANTHROPIC_API_KEY) ? '✅ YES          ║' : '❌ NO           ║'}`);
  console.log(`║  Telegram:        ${!!(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) ? '✅ YES          ║' : '❌ NO           ║'}`);
  console.log('╚═══════════════════════════════════════╝');
  console.log('');
});

module.exports = app;
