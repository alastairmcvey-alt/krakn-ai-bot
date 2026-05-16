/**
 * KRAKN·AI — Trading Bot Backend Server
 * =======================================
 * Securely signs and forwards trading requests to Kraken API.
 * Run this on your server/computer — NEVER expose this file publicly.
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');
const querystring = require('querystring');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ────────────────────────────────────────────────
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*', // Set to your frontend URL in production
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ─── Kraken API Config ─────────────────────────────────────────
const KRAKEN_API_KEY    = process.env.KRAKEN_API_KEY    || '';
const KRAKEN_API_SECRET = process.env.KRAKEN_API_SECRET || '';
const KRAKEN_HOST       = 'api.kraken.com';

// ─── Kraken Signature (Required for private endpoints) ────────
function getKrakenSignature(urlPath, data, secret, nonce) {
  const message       = querystring.stringify(data);
  const secret_buffer = Buffer.from(secret, 'base64');
  const hash          = crypto.createHash('sha256');
  const hmac          = crypto.createHmac('sha512', secret_buffer);
  const hash_digest   = hash.update(nonce + message).digest('binary');
  const hmac_digest   = hmac.update(urlPath + hash_digest, 'binary').digest('base64');
  return hmac_digest;
}

// ─── Generic Kraken Private Request ───────────────────────────
function krakenPrivateRequest(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const nonce = Date.now().toString();
    const urlPath = '/0/private/' + endpoint;

    const data = { nonce, ...params };
    const signature = getKrakenSignature(urlPath, data, KRAKEN_API_SECRET, nonce);

    const postData = querystring.stringify(data);

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
        'User-Agent': 'KRAKN-AI-Bot/2.1'
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.error && parsed.error.length > 0) {
            reject(new Error(parsed.error.join(', ')));
          } else {
            resolve(parsed.result);
          }
        } catch (e) {
          reject(new Error('Invalid JSON from Kraken'));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ─── Generic Kraken Public Request ────────────────────────────
function krakenPublicRequest(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const query = querystring.stringify(params);
    const path  = `/0/public/${endpoint}${query ? '?' + query : ''}`;

    const options = {
      hostname: KRAKEN_HOST,
      port: 443,
      path,
      method: 'GET',
      headers: { 'User-Agent': 'KRAKN-AI-Bot/2.1' }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.error && parsed.error.length > 0) {
            reject(new Error(parsed.error.join(', ')));
          } else {
            resolve(parsed.result);
          }
        } catch (e) {
          reject(new Error('Invalid JSON from Kraken'));
        }
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
    return res.status(400).json({
      error: 'Kraken API keys not configured. Check your .env file.'
    });
  }
  next();
}

// ══════════════════════════════════════════════════════════════
// PUBLIC ROUTES (No auth needed — market data)
// ══════════════════════════════════════════════════════════════

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    version: '2.1',
    keysConfigured: !!(KRAKEN_API_KEY && KRAKEN_API_SECRET),
    timestamp: new Date().toISOString()
  });
});

// Get ticker prices
app.get('/api/ticker', async (req, res) => {
  try {
    const pairs = req.query.pairs || 'XBTUSD,ETHUSD,SOLUSD,XRPUSD,ADAUSD';
    const result = await krakenPublicRequest('Ticker', { pair: pairs });
    
    // Normalise the response
    const tickers = {};
    for (const [krakenPair, data] of Object.entries(result)) {
      tickers[krakenPair] = {
        price: parseFloat(data.c[0]),       // last trade price
        bid:   parseFloat(data.b[0]),
        ask:   parseFloat(data.a[0]),
        high:  parseFloat(data.h[1]),       // 24h high
        low:   parseFloat(data.l[1]),       // 24h low
        volume: parseFloat(data.v[1]),      // 24h volume
        open:  parseFloat(data.o),
        change24h: (((parseFloat(data.c[0]) - parseFloat(data.o)) / parseFloat(data.o)) * 100).toFixed(2)
      };
    }
    res.json({ success: true, data: tickers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get OHLC candle data
app.get('/api/ohlc', async (req, res) => {
  try {
    const { pair = 'XBTUSD', interval = 60 } = req.query;
    const result = await krakenPublicRequest('OHLC', { pair, interval: parseInt(interval) });
    const key    = Object.keys(result).find(k => k !== 'last');
    res.json({ success: true, data: result[key], last: result.last });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get order book
app.get('/api/orderbook', async (req, res) => {
  try {
    const { pair = 'XBTUSD', count = 10 } = req.query;
    const result = await krakenPublicRequest('Depth', { pair, count: parseInt(count) });
    const key    = Object.keys(result)[0];
    res.json({ success: true, data: result[key] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// PRIVATE ROUTES (Require auth token + Kraken keys)
// ══════════════════════════════════════════════════════════════

// Get account balance
app.get('/api/balance', requireAuth, requireKeys, async (req, res) => {
  try {
    const result = await krakenPrivateRequest('Balance');
    // Convert to readable format
    const balances = {};
    for (const [asset, amount] of Object.entries(result)) {
      const val = parseFloat(amount);
      if (val > 0) balances[asset] = val;
    }
    res.json({ success: true, data: balances });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get open orders
app.get('/api/orders/open', requireAuth, requireKeys, async (req, res) => {
  try {
    const result = await krakenPrivateRequest('OpenOrders');
    res.json({ success: true, data: result.open || {} });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get closed/recent orders
app.get('/api/orders/closed', requireAuth, requireKeys, async (req, res) => {
  try {
    const result = await krakenPrivateRequest('ClosedOrders');
    res.json({ success: true, data: result.closed || {} });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get open positions (futures/margin)
app.get('/api/positions', requireAuth, requireKeys, async (req, res) => {
  try {
    const result = await krakenPrivateRequest('OpenPositions');
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get trade history
app.get('/api/trades', requireAuth, requireKeys, async (req, res) => {
  try {
    const result = await krakenPrivateRequest('TradesHistory');
    res.json({ success: true, data: result.trades || {} });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// PLACE ORDER  ← The core trading endpoint
// ──────────────────────────────────────────────────────────────
app.post('/api/order/place', requireAuth, requireKeys, async (req, res) => {
  try {
    const {
      pair,         // e.g. "XBTUSD"
      type,         // "buy" or "sell"
      ordertype,    // "market", "limit", "stop-loss"
      volume,       // amount in base currency
      price,        // limit price (required for limit orders)
      leverage,     // e.g. "5:1" for futures (optional)
      validate      // true = dry run, don't actually place
    } = req.body;

    // Validate required fields
    if (!pair || !type || !ordertype || !volume) {
      return res.status(400).json({
        error: 'Missing required fields: pair, type, ordertype, volume'
      });
    }

    // Sanity checks
    if (!['buy', 'sell'].includes(type)) {
      return res.status(400).json({ error: 'type must be "buy" or "sell"' });
    }
    if (!['market', 'limit', 'stop-loss', 'stop-loss-limit'].includes(ordertype)) {
      return res.status(400).json({ error: 'Invalid ordertype' });
    }
    if (ordertype === 'limit' && !price) {
      return res.status(400).json({ error: 'price required for limit orders' });
    }

    const params = {
      pair,
      type,
      ordertype,
      volume: String(volume),
    };

    if (price)    params.price    = String(price);
    if (leverage) params.leverage = String(leverage);
    if (validate) params.validate = true; // Test without placing

    console.log(`[ORDER] ${type.toUpperCase()} ${volume} ${pair} @ ${ordertype}${price ? ' $'+price : ''}${leverage ? ' x'+leverage : ''}`);

    const result = await krakenPrivateRequest('AddOrder', params);

    console.log(`[ORDER PLACED] txid: ${result.txid?.join(', ')}`);

    res.json({
      success: true,
      data: {
        txid:        result.txid,
        description: result.descr,
        message:     validate ? 'Order validated (not placed)' : 'Order placed successfully'
      }
    });
  } catch (err) {
    console.error('[ORDER ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Cancel an order
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

// Cancel all open orders
app.post('/api/order/cancel-all', requireAuth, requireKeys, async (req, res) => {
  try {
    const result = await krakenPrivateRequest('CancelAll');
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────
// BOT AUTO-TRADING  ← AI signal → automatic order
// ──────────────────────────────────────────────────────────────
let botConfig = {
  enabled:      false,
  riskLevel:    'conservative',  // conservative | moderate | aggressive
  maxTradeUSD:  100,
  takeProfitPct: 5,
  stopLossPct:   3,
  pairs:        ['XBTUSD'],
  confidenceMin: 75,             // Only trade if AI confidence >= this
};

let botState = {
  running:      false,
  lastSignal:   null,
  lastTrade:    null,
  tradesCount:  0,
  profitUSD:    0,
};

app.get('/api/bot/config', requireAuth, (req, res) => {
  res.json({ success: true, data: { ...botConfig, state: botState } });
});

app.post('/api/bot/config', requireAuth, (req, res) => {
  botConfig = { ...botConfig, ...req.body };
  res.json({ success: true, data: botConfig });
});

app.post('/api/bot/start', requireAuth, requireKeys, (req, res) => {
  if (botState.running) return res.json({ success: true, message: 'Bot already running' });
  botState.running = true;
  console.log('[BOT] Started auto-trading');
  startBotLoop();
  res.json({ success: true, message: 'Bot started' });
});

app.post('/api/bot/stop', requireAuth, (req, res) => {
  botState.running = false;
  console.log('[BOT] Stopped');
  res.json({ success: true, message: 'Bot stopped' });
});

app.get('/api/bot/status', requireAuth, (req, res) => {
  res.json({ success: true, data: botState });
});

// ─── Bot Loop ─────────────────────────────────────────────────
async function startBotLoop() {
  while (botState.running) {
    try {
      for (const pair of botConfig.pairs) {
        await runBotForPair(pair);
      }
    } catch (err) {
      console.error('[BOT ERROR]', err.message);
    }
    // Wait 60 seconds between checks
    await sleep(60000);
  }
}

async function runBotForPair(pair) {
  // 1. Get current price
  const tickerResult = await krakenPublicRequest('Ticker', { pair });
  const key = Object.keys(tickerResult)[0];
  const price = parseFloat(tickerResult[key].c[0]);
  const open  = parseFloat(tickerResult[key].o);
  const change24h = ((price - open) / open * 100).toFixed(2);

  // 2. Get simple technical signal (RSI-like based on recent candles)
  const signal = await computeSignal(pair, price, parseFloat(change24h));
  botState.lastSignal = { pair, signal, price, timestamp: new Date().toISOString() };

  console.log(`[BOT] ${pair} price=$${price} signal=${signal.action} confidence=${signal.confidence}%`);

  // 3. Only trade if confidence is high enough
  if (signal.confidence < botConfig.confidenceMin) {
    console.log(`[BOT] Skipping — confidence ${signal.confidence}% < min ${botConfig.confidenceMin}%`);
    return;
  }

  // 4. Calculate volume from maxTradeUSD
  const volume = (botConfig.maxTradeUSD / price).toFixed(8);

  // 5. Place the order
  if (signal.action === 'BUY' || signal.action === 'SELL') {
    const type = signal.action.toLowerCase();
    try {
      const order = await krakenPrivateRequest('AddOrder', {
        pair,
        type,
        ordertype: 'market',
        volume,
      });

      botState.lastTrade = {
        pair, type, volume, price,
        txid: order.txid,
        timestamp: new Date().toISOString()
      };
      botState.tradesCount++;

      console.log(`[BOT] ✅ Placed ${type.toUpperCase()} ${volume} ${pair} — txid: ${order.txid?.join(',')}`);
    } catch (err) {
      console.error(`[BOT] Order failed: ${err.message}`);
    }
  }
}

// Simple technical signal: RSI approximation from OHLC
async function computeSignal(pair, currentPrice, change24h) {
  try {
    const ohlcResult = await krakenPublicRequest('OHLC', { pair, interval: 60 });
    const key = Object.keys(ohlcResult).find(k => k !== 'last');
    const candles = ohlcResult[key].slice(-14); // Last 14 candles for RSI

    const closes = candles.map(c => parseFloat(c[4]));
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

    let action = 'HOLD';
    let confidence = 50;

    if (rsi < 30) {
      action = 'BUY';
      confidence = Math.min(95, 60 + (30 - rsi) * 2);
    } else if (rsi > 70) {
      action = 'SELL';
      confidence = Math.min(95, 60 + (rsi - 70) * 2);
    } else if (rsi < 45 && change24h > 0) {
      action = 'BUY';
      confidence = 55 + Math.abs(change24h);
    } else if (rsi > 55 && change24h < 0) {
      action = 'SELL';
      confidence = 55 + Math.abs(change24h);
    }

    // Conservative = higher threshold needed
    if (botConfig.riskLevel === 'conservative') confidence *= 0.85;
    if (botConfig.riskLevel === 'aggressive')   confidence *= 1.10;

    return { action, confidence: Math.min(99, Math.round(confidence)), rsi: Math.round(rsi) };
  } catch {
    return { action: 'HOLD', confidence: 0, rsi: 50 };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Start Server ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════╗');
  console.log('║        KRAKN·AI Bot Server v2.1       ║');
  console.log('╠═══════════════════════════════════════╣');
  console.log(`║  Running on http://localhost:${PORT}      ║`);
  console.log(`║  Keys configured: ${!!(KRAKEN_API_KEY && KRAKEN_API_SECRET) ? '✅ YES          ║' : '❌ NO — check .env║'}`);
  console.log('╚═══════════════════════════════════════╝');
  console.log('');
});

module.exports = app;
