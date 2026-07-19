/**
 * KRAKN·AI — Trading Bot Backend Server v4.0
 * =============================================
 * Phase 1: P&L tracking, multi-indicator signals, stop-loss, multi-timeframe
 * Phase 2: Persistent settings, Fear & Greed, trailing stop-loss, DCA bot
 * Phase 3: Portfolio history, tax export, bot state persistence
 * Sprint 1: Candlestick pattern recognition, volume anomaly alerts, sentiment scoring
 */

const express     = require('express');
const cors        = require('cors');
const crypto      = require('crypto');
const https       = require('https');
const querystring = require('querystring');
const fs          = require('fs');
const path        = require('path');

// Chart rendering for AI vision analysis
let createCanvas;
try {
  createCanvas = require('@napi-rs/canvas').createCanvas;
  // Quick test to verify binary works
  const testCanvas = createCanvas(10, 10);
  testCanvas.getContext('2d');
  console.log('[CANVAS] ✅ Chart rendering available — Vision analysis enabled');
} catch(e) {
  console.warn('[CANVAS] ⚠️  Canvas not available:', e.message);
  console.warn('[CANVAS]    Vision analysis disabled — charts will use numerical signals only');
  createCanvas = null;
}

require('dotenv').config();

// ─── Global Crash Protection ───────────────────────────────────
// Prevents ANY unhandled error from crashing the entire server
// Without this, one bad API response from Kraken/Telegram/Anthropic
// can kill the whole process and stop all trading
process.on('uncaughtException', (err) => {
  console.error('[CRASH PROTECTED] Uncaught exception:', err.message);
  console.error(err.stack);
  // Don't exit — keep running
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRASH PROTECTED] Unhandled promise rejection:', reason);
  // Don't exit — keep running
});

const app       = express();
const PORT      = process.env.PORT || 3001;
// Persistent storage path — uses Railway volume if available, falls back to local
const DATA_DIR  = fs.existsSync('/app/data') ? '/app/data' : path.join(__dirname);
const DATA_FILE = path.join(DATA_DIR, 'krakn_data.json');

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

// ─── Multi-Currency Pair Config ────────────────────────────────
// AUD pairs — your home currency (DOTAUD removed — not supported on Kraken AUD)
const AUD_PAIRS = ['XBTAUD','ETHAUD','XRPAUD','ADAAUD','SOLAUD','LTCAUD','LINKAUD'];

// USD pairs — unlocks 50+ additional coins
const USD_PAIRS = [
  'XBTUSD','ETHUSD','SOLUSD','XRPUSD','ADAUSD','LTCUSD','DOTUSD','LINKUSD',
  'MATICUSD','AVAXUSD','ATOMUSD','UNIUSD','AAVEUSD','DOGEUSD','SHIBUSDT',
  'OPUSD','ARBUSD','INJUSD','SUIUSD','APTUSD','NEARUSD','FTMUSD','ALGOUSD',
];

// Display names for all pairs
const PAIR_DISPLAY = {
  // AUD
  'XBTAUD':'BTC/AUD','ETHAUD':'ETH/AUD','XRPAUD':'XRP/AUD','ADAAUD':'ADA/AUD',
  'SOLAUD':'SOL/AUD','LTCAUD':'LTC/AUD','DOTAUD':'DOT/AUD','LINKAUD':'LINK/AUD',
  // USD
  'XBTUSD':'BTC/USD','ETHUSD':'ETH/USD','SOLUSD':'SOL/USD','XRPUSD':'XRP/USD',
  'ADAUSD':'ADA/USD','LTCUSD':'LTC/USD','DOTUSD':'DOT/USD','LINKUSD':'LINK/USD',
  'MATICUSD':'MATIC/USD','AVAXUSD':'AVAX/USD','ATOMUSD':'ATOM/USD','UNIUSD':'UNI/USD',
  'AAVEUSD':'AAVE/USD','DOGEUSD':'DOGE/USD','SHIBUSDT':'SHIB/USD','OPUSD':'OP/USD',
  'ARBUSD':'ARB/USD','INJUSD':'INJ/USD','SUIUSD':'SUI/USD','APTUSD':'APT/USD',
  'NEARUSD':'NEAR/USD','FTMUSD':'FTM/USD','ALGOUSD':'ALGO/USD',
};

// Which pairs to actively watch — controlled by user currency setting
// Default is AUD only, user can switch to USD or BOTH in settings
function getActivePairs(mode) {
  if (mode === 'USD')  return USD_PAIRS;
  if (mode === 'BOTH') return [...AUD_PAIRS, ...USD_PAIRS];
  return AUD_PAIRS; // default
}

// Detect base currency from pair name
function pairCurrency(pair) {
  if (pair.endsWith('AUD')) return 'AUD';
  if (pair.endsWith('USD') || pair.endsWith('USDT')) return 'USD';
  return 'AUD';
}

// Fallback pair names to try if primary fails
const PAIR_ALIASES = {
  'DOTAUD':  ['DOTAUD','DOT/AUD','XDOTAUD'],
  'LINKAUD': ['LINKAUD','LINK/AUD'],
  'DOTUSD':  ['DOTUSD','DOT/USD','XDOTUSD'],
  'SHIBUSDT':['SHIBUSDT','SHIB/USDT','SHIB/USD'],
};

// Format price in the correct currency
function fmtPrice(p, pair) {
  const currency = pair ? pairCurrency(pair) : 'AUD';
  const symbol   = currency === 'USD' ? 'US$' : 'A$';
  if (!p && p !== 0) return '--';
  if (p >= 1000) return symbol + Math.round(p).toLocaleString('en-AU');
  if (p >= 1)    return symbol + parseFloat(p).toFixed(2);
  if (p >= 0.01) return symbol + parseFloat(p).toFixed(4);
  return symbol + parseFloat(p).toFixed(8);
}

async function fetchSingleTicker(pair) {
  // Try primary pair name first, then aliases
  const attempts = [pair, ...(PAIR_ALIASES[pair] || [])];
  for (const attempt of attempts) {
    try {
      const result = await krakenPublicRequest('Ticker', { pair: attempt });
      const key    = Object.keys(result)[0];
      if (!key) continue;
      const d = result[key];
      return {
        price:     parseFloat(d.c[0]),
        bid:       parseFloat(d.b[0]),
        ask:       parseFloat(d.a[0]),
        high:      parseFloat(d.h[1]),
        low:       parseFloat(d.l[1]),
        volume:    parseFloat(d.v[1]),
        open:      parseFloat(d.o),
        change24h: (((parseFloat(d.c[0]) - parseFloat(d.o)) / parseFloat(d.o)) * 100).toFixed(2),
      };
    } catch(e) {
      if (attempt === attempts[attempts.length - 1]) {
        console.warn(`[TICKER] ${pair} failed: ${e.message}`);
      }
    }
  }
  return null;
}

// ─── Kraken Minimum Order Sizes ────────────────────────────────
const MIN_VOLUMES = {
  XBT:0.0001, ETH:0.002, SOL:0.02, XRP:5,
  ADA:5, LTC:0.02, DOT:0.5, LINK:0.2, UNI:0.2, MATIC:5
};

// ─── Advisor Settings ──────────────────────────────────────────
let advisorSettings = {
  enabled:       true,
  intervalHours: 1,
  pairs:         ['XBTAUD','ETHAUD','SOLAUD','XRPAUD','ADAAUD','LTCAUD','LINKAUD'],
  minConfidence: 65,
  includeNews:   true,
  lastRun:       null,
};

// ─── State ─────────────────────────────────────────────────────
let priceAlerts           = [];
let pendingBuyOpportunity = null;
const chatHistory         = {};
let selectedPairForChat   = 'XBTAUD'; // tracks last coin mentioned in Telegram

// ─── P&L Tracking ──────────────────────────────────────────────
// Stores every trade we make through the bot for P&L calculation
let tradeLog = [];          // { id, pair, sym, type, volume, price, valueAUD, timestamp, source }
let pnlByAsset = {};        // { BTC: { avgBuyPrice, totalBought, totalSold, realised } }

function recordTrade(pair, sym, type, volume, price, source = 'manual') {
  const valueAUD = parseFloat(volume) * parseFloat(price);
  const trade = {
    id:        Date.now().toString(),
    pair, sym, type,
    volume:    parseFloat(volume),
    price:     parseFloat(price),
    valueAUD,
    timestamp: new Date().toISOString(),
    source,    // 'bot-sell', 'bot-buy', 'manual', 'stop-loss'
  };
  tradeLog.push(trade);
  // Keep last 500 trades
  if (tradeLog.length > 500) tradeLog = tradeLog.slice(-500);

  // Update P&L tracking
  if (!pnlByAsset[sym]) pnlByAsset[sym] = { avgBuyPrice:0, totalVolume:0, totalCost:0, realisedPnl:0, tradeCount:0 };
  const asset = pnlByAsset[sym];
  if (type === 'buy') {
    // Update average buy price
    const newTotalCost   = asset.totalCost + valueAUD;
    const newTotalVolume = asset.totalVolume + parseFloat(volume);
    asset.avgBuyPrice = newTotalCost / newTotalVolume;
    asset.totalVolume = newTotalVolume;
    asset.totalCost   = newTotalCost;
  } else if (type === 'sell') {
    // Calculate realised P&L
    if (asset.avgBuyPrice > 0) {
      const costBasis     = asset.avgBuyPrice * parseFloat(volume);
      const proceeds      = valueAUD;
      asset.realisedPnl  += proceeds - costBasis;
      // Reduce position
      asset.totalVolume   = Math.max(0, asset.totalVolume - parseFloat(volume));
      asset.totalCost     = asset.avgBuyPrice * asset.totalVolume;
    }
  }
  asset.tradeCount++;
  console.log(`[P&L] Recorded ${type.toUpperCase()} ${volume} ${sym} @ ${fmtAUDServer(price)} — Realised P&L: ${fmtAUDServer(asset.realisedPnl)}`);
  // Save to disk so P&L survives restarts
  setTimeout(saveData, 100);
  return trade;
}

// Calculate unrealised P&L for a holding given current price
function getUnrealisedPnl(sym, currentPrice, currentQty) {
  const asset = pnlByAsset[sym];
  if (!asset || asset.avgBuyPrice === 0) return { unrealisedPnl: 0, avgBuyPrice: 0, pnlPct: 0 };
  const costBasis     = asset.avgBuyPrice * currentQty;
  const currentValue  = currentPrice * currentQty;
  const unrealisedPnl = currentValue - costBasis;
  const pnlPct        = costBasis > 0 ? ((unrealisedPnl / costBasis) * 100) : 0;
  return { unrealisedPnl, avgBuyPrice: asset.avgBuyPrice, pnlPct, realisedPnl: asset.realisedPnl || 0 };
}

// ─── Bot Config & State ────────────────────────────────────────
// MUST be declared before loadData() so settings can be restored on startup
let botConfig = {
  riskLevel:          'conservative',
  sellPct:            100,
  confidenceMin:      75,
  checkInterval:      60,
  minHoldingValueAUD: 50,
  stopLossEnabled:    true,
  stopLossPct:        8,
  trailingStop:       false,
  minHoldMinutes:     60,
  currencyMode:       'AUD',
  autoBuy:            false,   // when true — bot buys automatically without YES/NO prompt
  autoBuyMaxAUD:      200,     // maximum AUD per auto-buy trade
  autoBuyMinConfidence: 82,    // higher threshold for auto-buy (must be very confident)
};

// Track when each coin was last bought so we enforce minimum hold time
let lastBuyTimes = {}; // { sym: timestamp }
let botState = {
  running:     false,
  lastSignals: {},
  lastSell:    null,
  sellsCount:  0,
  lastCheck:   null,
};

// ─── Portfolio History ─────────────────────────────────────────
let portfolioHistory = []; // [{ date, valueAUD, timestamp }]

// ─── Target Allocation ─────────────────────────────────────────
// User sets desired % per coin — bot alerts when drifting > 5%
let targetAllocation = {}; // { BTC: 40, ETH: 30, SOL: 20, cash: 10 }

// ─── On-Chain Data Cache ───────────────────────────────────────
let onChainCache = {}; // { sym: { data, fetchedAt } }

// ─── Stop-Loss Peaks ──────────────────────────────────────────
let stopLossPeaks = {};

// ─── Grid Trading Config ──────────────────────────────────────
let gridConfigs = {}; // { pair: { enabled, upper, lower, gridCount, amountPerGrid, orders:[] } }

// ─── Rebalance Config ──────────────────────────────────────────
let rebalanceConfig = {
  enabled:        false,
  driftThreshold: 8,
  minTradeAUD:    50,
};

// ─── Smart Money Wallets ───────────────────────────────────────
let smartWallets = [
  { id:'sm1',  address:'1P5ZEDWTKTFGxQjZphgWPQUpe554WKDfHQ', label:'MicroStrategy Treasury',    chain:'bitcoin',  winRate:0.89, tags:['institutional','btc-only'], active:true },
  { id:'sm3',  address:'0x9bf4001d307dfd62b26a2f1307ee0c0307632d59', label:'DeFi Whale Alpha',     chain:'ethereum', winRate:0.72, tags:['defi','smart-trader'], active:true },
  { id:'sm4',  address:'0x28c6c06298d514db089934071355e5743bf21d60', label:'Binance Hot Wallet 14', chain:'ethereum', winRate:0.81, tags:['exchange','flow-indicator'], active:true },
  { id:'sm5',  address:'0x21a31ee1afc51d94c2efccaa2092ad1028285549', label:'Binance Hot Wallet 8',  chain:'ethereum', winRate:0.76, tags:['exchange','flow-indicator'], active:true },
  { id:'sm9',  address:'9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', label:'SOL Whale Alpha',     chain:'solana',   winRate:0.74, tags:['smart-trader','sol-native'], active:true },
];
let smartMoneyAlertLog = [];
let smartMoneyEnabled  = true;
let smartMoneyCache    = {}; // { walletId: { txs, fetchedAt } }

// ─── DCA (Dollar Cost Averaging) Bot ─────────────────────────
let dcaConfig = {
  enabled:       false,
  pairs:         ['XBTAUD'],
  amountAUD:     50,
  frequency:     'weekly',
  dayOfWeek:     1,
  hour:          9,
  lastRun:       null,
  totalSpent:    0,
};
let dcaTimer = null;

// ─── Persistent Storage ────────────────────────────────────────
function saveData() {
  try {
    const data = {
      advisorSettings, botConfig, dcaConfig,
      priceAlerts, tradeLog: tradeLog.slice(-500),
      pnlByAsset, stopLossPeaks, portfolioHistory,
      lastBuyTimes, targetAllocation,
      smartWallets, smartMoneyAlertLog,
      gridConfigs, rebalanceConfig,
      botRunning: botState.running,
      savedAt: new Date().toISOString(),
    };
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(DATA_FILE, json);
    // Also write a compact backup next to it
    fs.writeFileSync(DATA_FILE + '.bak', json);
    console.log(`[SAVE] ✅ Saved to ${DATA_FILE}`);
  } catch(e) { console.error('[SAVE] Error:', e.message); }
}

function loadData() {
  // Try primary file, then backup, then env variable
  const sources = [
    DATA_FILE,
    DATA_FILE + '.bak',
  ];
  for (const src of sources) {
    try {
      if (!fs.existsSync(src)) continue;
      const data = JSON.parse(fs.readFileSync(src, 'utf8'));
      if (data.advisorSettings) Object.assign(advisorSettings, data.advisorSettings);
      if (data.botConfig)       Object.assign(botConfig,       data.botConfig);
      if (data.dcaConfig)       Object.assign(dcaConfig,       data.dcaConfig);
      if (data.priceAlerts)     priceAlerts   = data.priceAlerts;
      if (data.tradeLog)        tradeLog      = data.tradeLog;
      if (data.pnlByAsset)      pnlByAsset      = data.pnlByAsset;
      if (data.stopLossPeaks)   stopLossPeaks   = data.stopLossPeaks;
      if (data.portfolioHistory)    portfolioHistory    = data.portfolioHistory;
      if (data.lastBuyTimes)        lastBuyTimes        = data.lastBuyTimes;
      if (data.targetAllocation)    targetAllocation    = data.targetAllocation;
      if (data.smartWallets?.length) smartWallets       = data.smartWallets;
      if (data.smartMoneyAlertLog)  smartMoneyAlertLog  = data.smartMoneyAlertLog;
      if (data.gridConfigs)         gridConfigs         = data.gridConfigs;
      if (data.rebalanceConfig)     Object.assign(rebalanceConfig, data.rebalanceConfig);
      // Auto-restart bot if it was running before the server restarted
      if (data.botRunning) {
        console.log('[LOAD] Bot was running before restart — will auto-start in 5s');
        setTimeout(() => {
          if (!botState.running) {
            botState.running = true;
            startAutoSellLoop();
            console.log('[LOAD] ✅ Bot auto-restarted');
          }
        }, 5000);
      }
      console.log(`[LOAD] ✅ Settings restored from ${src} — bot was ${data.botRunning ? 'ON (restarting)' : 'OFF'}`);
      console.log(`[LOAD] risk=${botConfig.riskLevel} confidence=${botConfig.confidenceMin}% stopLoss=${botConfig.stopLossPct}%`);
      return; // success
    } catch(e) { console.warn(`[LOAD] Failed to read ${src}:`, e.message); }
  }
  // Last resort — try SAVED_CONFIG environment variable
  try {
    if (process.env.SAVED_CONFIG) {
      const data = JSON.parse(process.env.SAVED_CONFIG);
      if (data.botConfig) Object.assign(botConfig, data.botConfig);
      if (data.advisorSettings) Object.assign(advisorSettings, data.advisorSettings);
      console.log('[LOAD] ✅ Settings restored from SAVED_CONFIG env var');
    } else {
      console.log('[LOAD] No saved data found — using defaults');
    }
  } catch(e) { console.log('[LOAD] No valid saved config found — using defaults'); }
}

// ─── Formatting Helpers ────────────────────────────────────────
function fmtAUDServer(p, pair) {
  if (!p && p !== 0) return '--';
  const currency = pair ? pairCurrency(pair) : 'AUD';
  const symbol   = currency === 'USD' ? 'US$' : 'A$';
  if (p >= 1000) return symbol + Math.round(p).toLocaleString('en-AU');
  if (p >= 1)    return symbol + parseFloat(p).toFixed(2);
  if (p >= 0.01) return symbol + parseFloat(p).toFixed(4);
  return symbol + parseFloat(p).toFixed(8);
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
        'User-Agent': 'KRAKN-AI-Bot/3.2'
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
      headers: { 'User-Agent': 'KRAKN-AI-Bot/3.2' }
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

// ─── Technical Indicator Calculators ──────────────────────────

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  const slice = closes.slice(-period - 1);
  const gains = [], losses = [];
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i] - slice[i-1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  const ag  = gains.reduce((a,b)=>a+b,0) / gains.length;
  const al  = losses.reduce((a,b)=>a+b,0) / losses.length;
  return Math.round(100 - (100 / (1 + (al === 0 ? 100 : ag/al))));
}

function calcEMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1];
  const k    = 2 / (period + 1);
  let ema    = closes.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1-k);
  return ema;
}

function calcMACD(closes) {
  if (closes.length < 26) return { macd: 0, signal: 0, histogram: 0, trend: 'NEUTRAL' };
  const ema12    = calcEMA(closes, 12);
  const ema26    = calcEMA(closes, 26);
  const macd     = ema12 - ema26;
  // Signal line = 9-period EMA of MACD (approximate)
  const macdLine = closes.slice(-9).map((_, i) => {
    const slice = closes.slice(0, closes.length - 8 + i);
    return calcEMA(slice, 12) - calcEMA(slice, 26);
  });
  const signal   = calcEMA(macdLine, 9);
  const histogram = macd - signal;
  const trend    = histogram > 0 ? 'BULLISH' : histogram < 0 ? 'BEARISH' : 'NEUTRAL';
  return { macd: parseFloat(macd.toFixed(2)), signal: parseFloat(signal.toFixed(2)), histogram: parseFloat(histogram.toFixed(2)), trend };
}

function calcBollingerBands(closes, period = 20, stdDevMult = 2) {
  if (closes.length < period) return { upper:0, middle:0, lower:0, position:'MIDDLE' };
  const slice  = closes.slice(-period);
  const middle = slice.reduce((a,b) => a+b, 0) / period;
  const stdDev = Math.sqrt(slice.reduce((sum, v) => sum + Math.pow(v - middle, 2), 0) / period);
  const upper  = middle + stdDevMult * stdDev;
  const lower  = middle - stdDevMult * stdDev;
  const last   = closes[closes.length - 1];
  let position = 'MIDDLE';
  if (last >= upper)       position = 'OVERBOUGHT';
  else if (last <= lower)  position = 'OVERSOLD';
  else if (last > middle)  position = 'UPPER_HALF';
  else                     position = 'LOWER_HALF';
  return { upper: parseFloat(upper.toFixed(2)), middle: parseFloat(middle.toFixed(2)), lower: parseFloat(lower.toFixed(2)), position };
}

function calcVolumeSignal(volumes, closes) {
  if (volumes.length < 10) return 'NEUTRAL';
  const recentVol = volumes.slice(-5).reduce((a,b) => a+b, 0) / 5;
  const avgVol    = volumes.slice(-20).reduce((a,b) => a+b, 0) / 20;
  const priceDir  = closes[closes.length-1] > closes[closes.length-6] ? 'UP' : 'DOWN';
  const volSpike  = recentVol > avgVol * 1.5;
  if (volSpike && priceDir === 'UP')   return 'STRONG_BUY';
  if (volSpike && priceDir === 'DOWN') return 'STRONG_SELL';
  if (recentVol > avgVol)              return priceDir === 'UP' ? 'BUY' : 'SELL';
  return 'NEUTRAL';
}

// Fetch OHLC and calculate all indicators for one timeframe
async function analyseTimeframe(pair, interval) {
  const ohlc   = await krakenPublicRequest('OHLC', { pair, interval });
  const k      = Object.keys(ohlc).find(k => k !== 'last');
  const candles = ohlc[k].slice(-50); // last 50 candles
  const closes  = candles.map(c => parseFloat(c[4]));
  const volumes = candles.map(c => parseFloat(c[6]));

  const rsi      = calcRSI(closes);
  const macd     = calcMACD(closes);
  const bb       = calcBollingerBands(closes);
  const volSig   = calcVolumeSignal(volumes, closes);
  const patterns = detectCandlePatterns(candles);
  const patScore = scorePatterns(patterns);

  // Score each indicator: +1 buy, -1 sell, 0 hold
  let score = 0;
  let signals = [];

  // RSI
  if (rsi < 30)      { score += 2; signals.push(`RSI ${rsi} oversold`); }
  else if (rsi < 45) { score += 1; signals.push(`RSI ${rsi} low`); }
  else if (rsi > 70) { score -= 2; signals.push(`RSI ${rsi} overbought`); }
  else if (rsi > 55) { score -= 1; signals.push(`RSI ${rsi} high`); }

  // MACD
  if (macd.trend === 'BULLISH')      { score += 1; signals.push('MACD bullish'); }
  else if (macd.trend === 'BEARISH') { score -= 1; signals.push('MACD bearish'); }

  // Bollinger Bands
  if (bb.position === 'OVERSOLD')       { score += 2; signals.push('Price at lower BB'); }
  else if (bb.position === 'LOWER_HALF'){ score += 1; }
  else if (bb.position === 'OVERBOUGHT'){ score -= 2; signals.push('Price at upper BB'); }
  else if (bb.position === 'UPPER_HALF'){ score -= 1; }

  // Volume
  if (volSig === 'STRONG_BUY')        { score += 2; signals.push('Volume surge on uptick'); }
  else if (volSig === 'BUY')          { score += 1; signals.push('Volume supporting rise'); }
  else if (volSig === 'STRONG_SELL')  { score -= 2; signals.push('Volume surge on downtick'); }
  else if (volSig === 'SELL')         { score -= 1; }

  // Candlestick Patterns — add to score and signals
  score += patScore.score;
  if (patScore.found.length) signals.push(...patScore.found.map(p => `Pattern: ${p}`));

  return { interval, rsi, macd, bb, volSig, patterns, score, signals };
}

// ─── Sprint 1: Candlestick Pattern Recognition ────────────────
// Detects 15 high-reliability patterns from raw OHLC candles
// No external API needed — pure maths from Kraken candle data
function detectCandlePatterns(candles) {
  if (candles.length < 3) return [];
  const patterns = [];

  // Helper: extract OHLC values from a candle array entry
  const O = i => parseFloat(candles[i][1]); // open
  const H = i => parseFloat(candles[i][2]); // high
  const L = i => parseFloat(candles[i][3]); // low
  const C = i => parseFloat(candles[i][4]); // close
  const body   = i => Math.abs(C(i) - O(i));
  const range  = i => H(i) - L(i);
  const upper  = i => H(i) - Math.max(O(i), C(i));
  const lower  = i => Math.min(O(i), C(i)) - L(i);
  const bull   = i => C(i) > O(i);
  const bear   = i => C(i) < O(i);

  const n = candles.length - 1; // index of last candle
  const avgBody = candles.slice(-10).reduce((s,c,_i,a) =>
    s + Math.abs(parseFloat(c[4]) - parseFloat(c[1])), 0) / 10;

  // ── Single candle patterns ────────────────────────────────

  // Hammer — small body at top, long lower wick, after downtrend → BULLISH
  if (lower(n) >= body(n) * 2 && upper(n) <= body(n) * 0.3 && body(n) > 0 &&
      C(n-1) < O(n-3)) {
    patterns.push({ name: 'Hammer', signal: 'BULLISH', strength: 2,
      desc: 'Long lower wick after downtrend — buyers stepping in' });
  }

  // Inverted Hammer — small body at bottom, long upper wick, after downtrend → potential BULLISH
  if (upper(n) >= body(n) * 2 && lower(n) <= body(n) * 0.3 && body(n) > 0 &&
      C(n-1) < O(n-3)) {
    patterns.push({ name: 'Inverted Hammer', signal: 'BULLISH', strength: 1,
      desc: 'Buyers attempted push higher — possible reversal forming' });
  }

  // Shooting Star — small body at bottom, long upper wick, after uptrend → BEARISH
  if (upper(n) >= body(n) * 2 && lower(n) <= body(n) * 0.3 && body(n) > 0 &&
      C(n-1) > O(n-3)) {
    patterns.push({ name: 'Shooting Star', signal: 'BEARISH', strength: 2,
      desc: 'Long upper wick after uptrend — buyers rejected at highs' });
  }

  // Doji — very small body (indecision)
  if (body(n) <= avgBody * 0.1 && range(n) > avgBody * 0.5) {
    const trendUp = C(n-1) > O(n-3);
    patterns.push({ name: 'Doji', signal: trendUp ? 'BEARISH' : 'BULLISH', strength: 1,
      desc: `Market indecision — ${trendUp ? 'uptrend may be stalling' : 'downtrend may be exhausting'}` });
  }

  // Marubozu — full body candle, no wicks → strong momentum
  if (upper(n) <= range(n) * 0.05 && lower(n) <= range(n) * 0.05 && body(n) >= avgBody * 1.5) {
    patterns.push({ name: bull(n) ? 'Bullish Marubozu' : 'Bearish Marubozu',
      signal: bull(n) ? 'BULLISH' : 'BEARISH', strength: 2,
      desc: bull(n) ? 'Strong buying pressure — full green candle, no wicks'
                    : 'Strong selling pressure — full red candle, no wicks' });
  }

  // ── Two candle patterns ───────────────────────────────────
  if (candles.length >= 2) {

    // Bullish Engulfing — red candle then larger green candle engulfs it → BULLISH
    if (bear(n-1) && bull(n) &&
        O(n) <= C(n-1) && C(n) >= O(n-1) &&
        body(n) > body(n-1)) {
      patterns.push({ name: 'Bullish Engulfing', signal: 'BULLISH', strength: 3,
        desc: 'Green candle fully engulfs previous red — strong reversal signal' });
    }

    // Bearish Engulfing — green candle then larger red candle engulfs it → BEARISH
    if (bull(n-1) && bear(n) &&
        O(n) >= C(n-1) && C(n) <= O(n-1) &&
        body(n) > body(n-1)) {
      patterns.push({ name: 'Bearish Engulfing', signal: 'BEARISH', strength: 3,
        desc: 'Red candle fully engulfs previous green — strong reversal signal' });
    }

    // Piercing Line — bear then bull closes above 50% of prior candle → BULLISH
    if (bear(n-1) && bull(n) &&
        O(n) < L(n-1) &&
        C(n) > (O(n-1) + C(n-1)) / 2 && C(n) < O(n-1)) {
      patterns.push({ name: 'Piercing Line', signal: 'BULLISH', strength: 2,
        desc: 'Bulls reclaim more than half of prior red candle — buyers gaining control' });
    }

    // Dark Cloud Cover — bull then bear closes below 50% of prior candle → BEARISH
    if (bull(n-1) && bear(n) &&
        O(n) > H(n-1) &&
        C(n) < (O(n-1) + C(n-1)) / 2 && C(n) > O(n-1)) {
      patterns.push({ name: 'Dark Cloud Cover', signal: 'BEARISH', strength: 2,
        desc: 'Bears reclaim more than half of prior green candle — sellers gaining control' });
    }

    // Bullish Harami — large red then small green inside → BULLISH
    if (bear(n-1) && bull(n) &&
        O(n) > C(n-1) && C(n) < O(n-1) &&
        body(n) <= body(n-1) * 0.5) {
      patterns.push({ name: 'Bullish Harami', signal: 'BULLISH', strength: 1,
        desc: 'Small green inside large red — selling pressure weakening' });
    }

    // Bearish Harami — large green then small red inside → BEARISH
    if (bull(n-1) && bear(n) &&
        O(n) < C(n-1) && C(n) > O(n-1) &&
        body(n) <= body(n-1) * 0.5) {
      patterns.push({ name: 'Bearish Harami', signal: 'BEARISH', strength: 1,
        desc: 'Small red inside large green — buying pressure weakening' });
    }
  }

  // ── Three candle patterns ─────────────────────────────────
  if (candles.length >= 3) {

    // Morning Star — bear, small body, bull → BULLISH reversal
    if (bear(n-2) && body(n-1) <= avgBody * 0.4 &&
        bull(n) && C(n) >= (O(n-2) + C(n-2)) / 2) {
      patterns.push({ name: 'Morning Star', signal: 'BULLISH', strength: 3,
        desc: 'Classic 3-candle reversal at bottom — one of the most reliable bullish signals' });
    }

    // Evening Star — bull, small body, bear → BEARISH reversal
    if (bull(n-2) && body(n-1) <= avgBody * 0.4 &&
        bear(n) && C(n) <= (O(n-2) + C(n-2)) / 2) {
      patterns.push({ name: 'Evening Star', signal: 'BEARISH', strength: 3,
        desc: 'Classic 3-candle reversal at top — one of the most reliable bearish signals' });
    }

    // Three White Soldiers — three consecutive strong green candles → BULLISH
    if (bull(n) && bull(n-1) && bull(n-2) &&
        C(n) > C(n-1) && C(n-1) > C(n-2) &&
        O(n) > O(n-1) && O(n-1) > O(n-2) &&
        body(n) >= avgBody && body(n-1) >= avgBody && body(n-2) >= avgBody) {
      patterns.push({ name: 'Three White Soldiers', signal: 'BULLISH', strength: 3,
        desc: 'Three strong green candles in a row — sustained buying pressure' });
    }

    // Three Black Crows — three consecutive strong red candles → BEARISH
    if (bear(n) && bear(n-1) && bear(n-2) &&
        C(n) < C(n-1) && C(n-1) < C(n-2) &&
        O(n) < O(n-1) && O(n-1) < O(n-2) &&
        body(n) >= avgBody && body(n-1) >= avgBody && body(n-2) >= avgBody) {
      patterns.push({ name: 'Three Black Crows', signal: 'BEARISH', strength: 3,
        desc: 'Three strong red candles in a row — sustained selling pressure' });
    }
  }

  return patterns;
}

// Calculate pattern score contribution for the signal engine
function scorePatterns(patterns) {
  let score = 0;
  const found = [];
  for (const p of patterns) {
    const pts = p.strength * (p.signal === 'BULLISH' ? 1 : -1);
    score += pts;
    found.push(`${p.signal === 'BULLISH' ? '🟢' : '🔴'} ${p.name}`);
  }
  return { score, found };
}

// ─── Sprint 1: Volume Anomaly Detection ───────────────────────
// Alerts when volume is significantly above normal — often precedes big moves
let volumeAnomalyCache = {}; // { pair: lastAlertTime } — prevent spam

function detectVolumeAnomaly(volumes) {
  if (volumes.length < 20) return null;
  const recent    = volumes.slice(-3).reduce((a,b) => a+b, 0) / 3;  // avg of last 3 candles
  const baseline  = volumes.slice(-20, -3).reduce((a,b) => a+b, 0) / 17; // 17-candle avg before that
  if (baseline === 0) return null;
  const ratio = recent / baseline;
  if (ratio >= 3.0) return { level: 'EXTREME', ratio: ratio.toFixed(1), emoji: '🚨' };
  if (ratio >= 2.0) return { level: 'HIGH',    ratio: ratio.toFixed(1), emoji: '⚡' };
  if (ratio >= 1.5) return { level: 'ELEVATED',ratio: ratio.toFixed(1), emoji: '📊' };
  return null;
}

async function checkVolumeAnomalies() {
  for (const pair of getActivePairs(botConfig.currencyMode)) {
    try {
      // Only check pairs with active holdings or being watched
      const dp = PAIR_DISPLAY[pair] || pair;

      // Rate limit — don't alert same pair more than once per 2 hours
      const lastAlert = volumeAnomalyCache[pair];
      if (lastAlert && (Date.now() - lastAlert) < 2 * 60 * 60 * 1000) continue;

      const ohlc    = await krakenPublicRequest('OHLC', { pair, interval: 15 });
      const k       = Object.keys(ohlc).find(k => k !== 'last');
      const candles = ohlc[k].slice(-25);
      const volumes = candles.map(c => parseFloat(c[6]));
      const closes  = candles.map(c => parseFloat(c[4]));

      const anomaly = detectVolumeAnomaly(volumes);
      if (!anomaly) continue;

      const ticker   = await fetchSingleTicker(pair);
      const price    = ticker?.price || 0;
      const priceDir = closes[closes.length-1] > closes[closes.length-4] ? '📈 Rising' : '📉 Falling';
      const patterns = detectCandlePatterns(candles);
      const patternStr = patterns.length
        ? `\nPatterns: ${patterns.map(p=>p.name).join(', ')}`
        : '';

      volumeAnomalyCache[pair] = Date.now();

      await sendTelegram(
        `${anomaly.emoji} <b>VOLUME ANOMALY — ${dp}</b>\n\n` +
        `Volume is <b>${anomaly.ratio}x</b> above normal (${anomaly.level})\n` +
        `Price: ${fmtAUDServer(price)} — ${priceDir}` +
        `${patternStr}\n\n` +
        `⚠️ Big move may be coming. Check your position.`
      );

      console.log(`[VOLUME ANOMALY] ${dp} — ${anomaly.ratio}x normal volume`);
    } catch(e) { /* silent — don't crash loop */ }
  }
}

// ─── Sprint 1: Sentiment Scoring ──────────────────────────────
// Scores market sentiment from -10 to +10 per coin
// Feeds directly into AI decision making
let sentimentCache = {}; // { sym: { score, label, fetchedAt } }

async function fetchSentimentScore(sym) {
  const cached = sentimentCache[sym];
  if (cached && (Date.now() - cached.fetchedAt) < 2 * 60 * 60 * 1000) return cached;

  const fallback = { score: 0, label: 'Unknown', reasons: [], fetchedAt: Date.now() };

  try {
    const prompt = `Score crypto sentiment for ${sym} from -10 to +10. Return ONLY this JSON, nothing else:
{"score":3,"label":"Mildly Bullish","reasons":["reason1"]}`;

    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 25000);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 150,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });
    clearTimeout(timeout);

    const data = await response.json();
    const text = (data.content || [])
      .filter(c => c.type === 'text').map(c => c.text).join('').trim();

    if (!text) throw new Error('Empty response');

    // Extract JSON even if Claude adds surrounding text
    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) throw new Error('No JSON in response');

    const parsed = JSON.parse(match[0]);
    const result = {
      score:     Math.max(-10, Math.min(10, parseInt(parsed.score) || 0)),
      label:     parsed.label || 'Neutral',
      reasons:   Array.isArray(parsed.reasons) ? parsed.reasons.slice(0,2) : [],
      fetchedAt: Date.now(),
    };
    sentimentCache[sym] = result;
    console.log(`[SENTIMENT] ${sym}: ${result.score} (${result.label})`);
    return result;
  } catch(e) {
    console.warn(`[SENTIMENT] Failed for ${sym}:`, e.message);
    sentimentCache[sym] = fallback; // cache failure to prevent repeated retries
    return fallback;
  }
}

function sentimentEmoji(score) {
  if (score >= 7)  return '🚀 Extreme Greed';
  if (score >= 3)  return '🟢 Bullish';
  if (score >= -2) return '🟡 Neutral';
  if (score >= -6) return '🔴 Bearish';
  return '💀 Extreme Fear';
}
async function computeSignalForPair(pair) {
  try {
    // Analyse 3 timeframes numerically
    const [tf15, tf60, tf240] = await Promise.all([
      analyseTimeframe(pair, 15),
      analyseTimeframe(pair, 60),
      analyseTimeframe(pair, 240),
    ]);

    const weightedScore = (tf15.score * 0.5) + (tf60.score * 2) + (tf240.score * 4);
    const maxScore      = 26;

    let action = 'HOLD', confidence = 50;
    if (weightedScore >= 6)       { action='BUY';  confidence=Math.min(95,55+(weightedScore/maxScore)*40); }
    else if (weightedScore <= -6) { action='SELL'; confidence=Math.min(95,55+(Math.abs(weightedScore)/maxScore)*40); }
    else if (weightedScore >= 3)  { action='BUY';  confidence=Math.min(70,45+(weightedScore/maxScore)*30); }
    else if (weightedScore <= -3) { action='SELL'; confidence=Math.min(70,45+(Math.abs(weightedScore)/maxScore)*30); }

    if (botConfig.riskLevel === 'conservative') confidence *= 0.85;
    if (botConfig.riskLevel === 'aggressive')   confidence *= 1.10;

    const allSignals = [
      ...tf15.signals.map(s => `15m: ${s}`),
      ...tf60.signals.map(s => `1h: ${s}`),
      ...tf240.signals.map(s => `4h: ${s}`),
    ];

    // ── Multi-Timeframe Vision Analysis ───────────────────────
    // Renders charts at 5 timeframes and sends all to Claude Vision
    // Weights: 15m=0.5, 1h=1, 4h=2, 1D=3, 1W=2 (longer = more reliable patterns)
    let vision     = null;
    let visionAll  = {}; // { '15m': analysis, '1h': analysis, ... }

    if (createCanvas) {
      try {
        const tfConfigs = [
          { key:'15m', interval:15,   candles:80,  weight:0.5, label:'15-Min' },
          { key:'1h',  interval:60,   candles:60,  weight:1.0, label:'1-Hour' },
          { key:'4h',  interval:240,  candles:60,  weight:2.0, label:'4-Hour' },
          { key:'1d',  interval:1440, candles:30,  weight:3.0, label:'Daily'  },
          { key:'1w',  interval:10080,candles:20,  weight:2.0, label:'Weekly' },
        ];

        // Fetch and analyse all timeframes SEQUENTIALLY with delays
        // Prevents overwhelming the Claude API with 40 simultaneous calls
        const visionResults = [];
        for (const tf of tfConfigs) {
          try {
            // Small delay between each timeframe to avoid rate limits
            if (visionResults.length > 0) await new Promise(r => setTimeout(r, 800));
            const ohlc    = await krakenPublicRequest('OHLC', { pair, interval: tf.interval });
            const k       = Object.keys(ohlc).find(k => k !== 'last');
            if (!k) continue;
            const candles = ohlc[k].slice(-tf.candles);
            const result  = await analyseChartWithVision(pair, candles, {
              rsi:           tf.key === '1h' ? tf60.rsi : tf.key === '4h' ? tf240.rsi : tf60.rsi,
              macdTrend:     tf60.macd.trend,
              bbPosition:    tf60.bb.position,
              weightedScore: Math.round(weightedScore),
              timeframe:     tf.label,
            });
            if (result) visionResults.push({ ...tf, result, status:'fulfilled' });
          } catch(e) {
            console.warn(`[VISION ${tf.key}] ${PAIR_DISPLAY[pair]||pair}:`, e.message);
          }
        }

        // Collect results and compute weighted vision score
        let visionScoreSum  = 0;
        let visionWeightSum = 0;
        let bullishTFs = 0, bearishTFs = 0, holdTFs = 0;
        const visionSignals = [];

        visionResults.forEach(r => {
          if (!r?.result) return;
          const { key, label, weight, result } = r;
          visionAll[key] = result;

          // Accumulate weighted visual score (-5 to +5 per TF)
          const tfScore = (result.visualScore - 5) * weight;
          visionScoreSum  += tfScore;
          visionWeightSum += weight;

          if (result.visionAction === 'BUY')  bullishTFs++;
          else if (result.visionAction === 'SELL') bearishTFs++;
          else holdTFs++;

          if (result.visualPattern !== 'No clear pattern' && result.patternStrength >= 6) {
            visionSignals.push(`👁 ${label}: ${result.visualPattern} (${result.visionAction} ${result.visionConfidence}%)`);
          }

          console.log(`[VISION ${key}] ${PAIR_DISPLAY[pair]||pair}: ${result.visualPattern} → ${result.visionAction} ${result.visionConfidence}%`);
        });

        // Primary vision = 1h result (most balanced for intraday decisions)
        vision = visionAll['1h'] || visionAll['4h'] || null;

        // Multi-TF consensus — what do most timeframes agree on?
        const totalTFs = bullishTFs + bearishTFs + holdTFs;
        const avgVisionScore = visionWeightSum > 0 ? visionScoreSum / visionWeightSum : 0;

        if (totalTFs > 0) {
          // Strong consensus — 3+ timeframes agree
          if (bullishTFs >= 3) {
            confidence = Math.min(97, confidence * (1 + (bullishTFs * 0.06)));
            visionSignals.push(`👁 ${bullishTFs}/${totalTFs} timeframes BULLISH`);
            if (action !== 'BUY' && bullishTFs >= 4) {
              action = 'BUY';
              visionSignals.push('👁 Vision consensus override → BUY');
            }
          } else if (bearishTFs >= 3) {
            confidence = Math.min(97, confidence * (1 + (bearishTFs * 0.06)));
            visionSignals.push(`👁 ${bearishTFs}/${totalTFs} timeframes BEARISH`);
            if (action !== 'SELL' && bearishTFs >= 4) {
              action = 'SELL';
              visionSignals.push('👁 Vision consensus override → SELL');
            }
          }

          // Mixed signals — reduce confidence
          if (bullishTFs >= 2 && bearishTFs >= 2) {
            confidence *= 0.85;
            visionSignals.push(`⚠️ Vision mixed: ${bullishTFs} bull vs ${bearishTFs} bear TFs`);
          }

          // 1h confirms action — boost
          if (vision?.visionAction === action && vision?.patternStrength >= 7) {
            confidence = Math.min(97, confidence * 1.12);
          }

          // Daily chart strongly disagrees — significant warning
          const dailyVision = visionAll['1d'];
          if (dailyVision?.visionAction && dailyVision.visionAction !== action &&
              dailyVision.visionAction !== 'HOLD' && dailyVision.visionConfidence >= 75) {
            confidence *= 0.80;
            visionSignals.push(`⚠️ Daily chart disagrees: ${dailyVision.visionAction} (${dailyVision.visualPattern})`);
          }
        }

        allSignals.push(...visionSignals);

      } catch(e) { console.warn('[VISION] Multi-TF failed:', e.message); }
    }

    return {
      action,
      confidence:   Math.min(99, Math.round(confidence)),
      weightedScore,
      signals:      allSignals,
      vision,
      visionAll,
      patterns: [
        ...tf60.patterns.map(p => ({ ...p, tf: '1h' })),
        ...tf240.patterns.map(p => ({ ...p, tf: '4h' })),
      ],
      timeframes: {
        '15m': { rsi:tf15.rsi, macd:tf15.macd.trend, bb:tf15.bb.position, score:tf15.score, patterns:tf15.patterns.map(p=>p.name) },
        '1h':  { rsi:tf60.rsi, macd:tf60.macd.trend, bb:tf60.bb.position, score:tf60.score, patterns:tf60.patterns.map(p=>p.name) },
        '4h':  { rsi:tf240.rsi, macd:tf240.macd.trend, bb:tf240.bb.position, score:tf240.score, patterns:tf240.patterns.map(p=>p.name) },
      },
      rsi: tf60.rsi,
    };
  } catch(e) {
    console.error(`[SIGNAL] Error for ${pair}:`, e.message);
    return { action:'HOLD', confidence:0, rsi:50, signals:[], timeframes:{}, vision:null };
  }
}

// ─── Fear & Greed Index ────────────────────────────────────────
let fearGreedCache = { value: null, label: '', fetchedAt: null };

async function fetchFearGreed() {
  // Cache for 1 hour
  if (fearGreedCache.value && fearGreedCache.fetchedAt && (Date.now() - fearGreedCache.fetchedAt) < 3600000) {
    return fearGreedCache;
  }
  try {
    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.alternative.me',
        path: '/fng/?limit=1',
        method: 'GET',
        headers: { 'User-Agent': 'KRAKN-AI-Bot/3.1' }
      };
      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.end();
    });
    const entry = result?.data?.[0];
    if (entry) {
      fearGreedCache = {
        value:     parseInt(entry.value),
        label:     entry.value_classification,
        fetchedAt: Date.now(),
      };
      console.log(`[FEAR&GREED] ${fearGreedCache.value} — ${fearGreedCache.label}`);
    }
  } catch(e) {
    console.warn('[FEAR&GREED] Fetch failed:', e.message);
  }
  return fearGreedCache;
}

// ─── Advisor ───────────────────────────────────────────────────
let advisorTimer = null;

function scheduleAdvisor() {
  if (advisorTimer) clearInterval(advisorTimer);
  if (!advisorSettings.enabled) { console.log('[ADVISOR] Disabled'); return; }
  const ms = advisorSettings.intervalHours * 60 * 60 * 1000;
  advisorTimer = setInterval(async () => {
    try { if (advisorSettings.enabled) await runAdvisor(); }
    catch(e) { console.error('[ADVISOR] Interval error:', e.message); }
  }, ms);
  console.log(`[ADVISOR] Scheduled every ${advisorSettings.intervalHours}h`);
}

// Buy opportunity check runs independently every hour
// regardless of advisor interval setting
let buyCheckTimer = null;
function scheduleBuyCheck() {
  if (buyCheckTimer) clearInterval(buyCheckTimer);
  buyCheckTimer = setInterval(async () => {
    try { await checkBuyOpportunity(); }
    catch(e) { console.error('[BUY CHECK] Interval error:', e.message); }
  }, 60 * 60 * 1000);
  console.log('[BUY CHECK] Scheduled every 1h (independent of advisor interval)');
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
    const fearGreed     = await fetchFearGreed();
    const fgContext     = fearGreed.value
      ? `\nFear & Greed Index: ${fearGreed.value}/100 (${fearGreed.label})${fearGreed.value <= 25 ? ' — Extreme Fear' : fearGreed.value >= 75 ? ' — Extreme Greed' : ''}`
      : '';

    // Sprint 1: Add sentiment scores and signals sequentially (not parallel)
    // This prevents overwhelming Claude API with simultaneous requests
    const enrichedMarket = [];
    for (const d of marketData) {
      try {
        const sym       = (d.displayPair||PAIR_DISPLAY[d.pair]||d.pair).replace('/AUD','').replace('/USD','');
        const sentiment = await fetchSentimentScore(sym);
        // Stagger between coins to avoid rate limits
        await new Promise(r => setTimeout(r, 500));
        const signal    = await computeSignalForPair(d.pair);
        const topPat    = signal.patterns?.[0];
        enrichedMarket.push({ ...d, sentiment, signal, topPattern: topPat });
        // Brief pause between full signal computations
        await new Promise(r => setTimeout(r, 1000));
      } catch(e) {
        console.warn(`[ADVISOR] Failed to enrich ${d.pair}:`, e.message);
        enrichedMarket.push({ ...d, sentiment:{ score:0, label:'Unknown' }, signal:{ action:'HOLD', confidence:50, rsi:50, weightedScore:0, signals:[] }, topPattern:null });
      }
    }

    const marketSummary = enrichedMarket.map(d =>
      `${d.displayPair}: ${fmtAUDServer(d.price)} (${d.change24h > 0 ? '+' : ''}${d.change24h}% 24h)\n` +
      `  Technical: ${d.signal.action} ${d.signal.confidence}% | RSI ${d.signal.rsi} | Score ${d.signal.weightedScore}\n` +
      `  Sentiment: ${d.sentiment.score}/10 (${d.sentiment.label})\n` +
      `  ${d.topPattern ? `Pattern: ${d.topPattern.name} — ${d.topPattern.desc}` : 'No key patterns'}`
    ).join('\n\n');

    const sydneyTime = new Date().toLocaleString('en-AU', { timeZone:'Australia/Sydney', dateStyle:'short', timeStyle:'short' });

    const prompt = `You are an expert crypto trading advisor for an Australian retail investor.
All prices are in Australian Dollars (AUD) from Kraken. Do NOT mention USD conversion.

MARKET ANALYSIS (Technical + Sentiment):
${marketSummary}
${balanceContext}
${fgContext}
${newsContext ? `\nLATEST NEWS:\n${newsContext}` : ''}

Give clear actionable trading advice for each coin. Include BUY/SELL/HOLD, confidence %, one sentence reason that references BOTH technical signals AND sentiment where relevant.

Format EXACTLY like this:
🤖 <b>KRAKN·AI Market Update</b>
⏰ ${sydneyTime} AEST
${fgContext ? `\n😱 Sentiment: ${fearGreed.value}/100 — ${fearGreed.label}` : ''}

For each coin:
[emoji] <b>[PAIR]</b> — $[price] AUD
[action emoji] <b>[BUY/SELL/HOLD]</b> [confidence]% — [reason]
${balanceContext ? '💰 Suggested: $[amount] AUD' : ''}

Use 🟢 BUY, 🔴 SELL, 🟡 HOLD. Use 📈 if up, 📉 if down.
${newsContext ? '\n📰 <b>NEWS:</b> [one sentence]' : ''}

Only include coins above ${advisorSettings.minConfidence}% confidence. If none qualify say "No strong signals right now."`;

    const advice = await callClaude(prompt, 900);
    if (advice) {
      await sendTelegram(advice);
      console.log('[ADVISOR] Telegram sent');
    }

    if (advisorSettings.intervalHours <= 1) {
      await checkBuyOpportunities(enrichedMarket.map(d => ({ ...d, rsi: d.signal.rsi })));
    }

  } catch(err) {
    console.error('[ADVISOR ERROR]', err.message);
  }
}

// ─── Standalone Buy Opportunity Check ─────────────────────────
// Runs every hour independently so daily advisor doesn't kill buy signals
// Scans ALL pairs — not just the advisor pairs
async function checkBuyOpportunity() {
  try {
    console.log('[BUY CHECK] Scanning all pairs...');
    const marketData = [];
    for (const pair of getActivePairs(botConfig.currencyMode)) { // ALL pairs, not just advisor pairs
      try {
        const ticker = await fetchSingleTicker(pair);
        if (!ticker) continue;
        marketData.push({
          pair,
          displayPair: PAIR_DISPLAY[pair] || pair,
          price:   ticker.price,
          change24h: ticker.change24h,
          high:    ticker.high,
          low:     ticker.low,
        });
      } catch(e) {}
    }
    await checkBuyOpportunities(marketData);
  } catch(e) { console.error('[BUY CHECK ERROR]', e.message); }
}

// ─── Buy Opportunity Detector ──────────────────────────────────
async function checkBuyOpportunities(marketData) {
  try {
    let audCash = 0, usdCash = 0;
    if (KRAKEN_API_KEY && KRAKEN_API_SECRET) {
      const bal = await krakenPrivateRequest('Balance');
      audCash   = parseFloat(bal['ZAUD'] || bal['AUD'] || 0);
      usdCash   = parseFloat(bal['ZUSD'] || bal['USD'] || 0);
    }

    const mode = botConfig.currencyMode || 'AUD';
    const availableCash = mode === 'USD' ? usdCash : mode === 'BOTH' ? audCash + usdCash : audCash;
    if (availableCash < 10) { console.log('[BUY CHECK] Insufficient cash'); return; }

    let bestOpportunity = null;

    for (const d of marketData) {
      try {
        // Use full multi-indicator signal — same engine as dashboard
        const signal = d.signal || await computeSignalForPair(d.pair);

        // Trigger on BUY signal with sufficient confidence
        // OR RSI oversold even if confidence slightly below threshold
        const rsiOversold  = signal.rsi <= 32;
        const strongSignal = signal.action === 'BUY' && signal.confidence >= advisorSettings.minConfidence;
        const weakSignal   = signal.action === 'BUY' && rsiOversold && signal.confidence >= (advisorSettings.minConfidence - 10);

        if (!strongSignal && !weakSignal) continue;

        const ticker = await fetchSingleTicker(d.pair);
        if (!ticker) continue;

        // Get sentiment for extra context
        const sym       = (d.displayPair || PAIR_DISPLAY[d.pair] || d.pair).replace('/AUD','');
        const sentiment = sentimentCache[sym] || { score: 0, label: 'Unknown' };

        // Score this opportunity — higher is better
        const oppScore = signal.confidence
          + (rsiOversold ? 10 : 0)
          + (sentiment.score > 0 ? sentiment.score : 0);

        if (!bestOpportunity || oppScore > bestOpportunity.oppScore) {
          bestOpportunity = {
            pair:         d.pair,
            displayPair:  d.displayPair || PAIR_DISPLAY[d.pair] || d.pair,
            sym,
            price:        ticker.price,
            change24h:    ticker.change24h,
            high:         ticker.high,
            low:          ticker.low,
            rsi:          signal.rsi,
            confidence:   signal.confidence,
            weightedScore: signal.weightedScore,
            patterns:     signal.patterns || [],
            sentiment,
            oppScore,
          };
        }
      } catch(e) { console.warn(`[BUY CHECK] Error checking ${d.pair}:`, e.message); }
    }

    if (!bestOpportunity) {
      console.log('[BUY CHECK] No qualifying opportunities this run');
      return;
    }

    const pairCurr     = pairCurrency(bestOpportunity.pair);
    const cashForPair  = pairCurr === 'USD' ? usdCash : audCash;
    const suggestedAUD = Math.min(cashForPair * 0.25, cashForPair - 10);
    if (suggestedAUD < 5) return;

    const volume   = (suggestedAUD / bestOpportunity.price).toFixed(8);
    const topPat   = bestOpportunity.patterns[0];
    const patStr   = topPat ? `\nPattern: ${topPat.name} — ${topPat.desc}` : '';
    const sentStr  = bestOpportunity.sentiment.score !== 0
      ? `\nSentiment: ${bestOpportunity.sentiment.score}/10 (${bestOpportunity.sentiment.label})`
      : '';
    const vision    = bestOpportunity.signal?.vision;
    const visionAll = bestOpportunity.signal?.visionAll || {};
    const visionTFs = Object.entries(visionAll)
      .filter(([,v]) => v?.visualPattern && v.visualPattern !== 'No clear pattern')
      .map(([tf,v]) => `  ${tf.toUpperCase()}: ${v.visualPattern} → ${v.visionAction} ${v.visionConfidence}%`)
      .join('\n');
    const visStr = visionTFs
      ? `\n👁 <b>Vision Analysis (${Object.keys(visionAll).length} TFs):</b>\n${visionTFs}`
      : vision ? `\n👁 ${vision.visualPattern} — ${vision.keyObservation}` : '';

    const sydneyTime = new Date().toLocaleString('en-AU', {
      timeZone:'Australia/Sydney', dateStyle:'short', timeStyle:'short'
    });

    // ── AUTO-BUY MODE ─────────────────────────────────────────
    // If autoBuy is enabled AND confidence exceeds the higher auto threshold
    // AND the trade size is within the safety cap — execute immediately
    if (botConfig.autoBuy &&
        bestOpportunity.confidence >= botConfig.autoBuyMinConfidence &&
        suggestedAUD <= botConfig.autoBuyMaxAUD) {

      try {
        console.log(`[AUTO-BUY] Executing ${bestOpportunity.displayPair} — ${bestOpportunity.confidence}% confidence`);

        const order = await krakenPrivateRequest('AddOrder', {
          pair:      bestOpportunity.pair,
          type:      'buy',
          ordertype: 'market',
          volume,
        });

        recordTrade(bestOpportunity.pair, bestOpportunity.sym, 'buy', volume, bestOpportunity.price, 'auto-buy');
        lastBuyTimes[bestOpportunity.sym] = Date.now();
        saveData();

        await sendTelegram(
          `🤖 <b>AUTO-BUY EXECUTED!</b>\n\n` +
          `<b>${bestOpportunity.displayPair}</b>\n` +
          `Bought: ${volume} ${bestOpportunity.sym}\n` +
          `Price: ${fmtAUDServer(bestOpportunity.price, bestOpportunity.pair)}\n` +
          `Total: ≈ ${fmtAUDServer(suggestedAUD, bestOpportunity.pair)}\n` +
          `TXID: ${order.txid?.join(', ')}\n\n` +
          `Signal: RSI ${bestOpportunity.rsi} | Score: ${bestOpportunity.weightedScore} | Confidence: ${bestOpportunity.confidence}%\n` +
          `${patStr}${sentStr}${visStr}\n\n` +
          `⏱ Min hold: ${botConfig.minHoldMinutes} min\n` +
          `🔴 To disable auto-buy, go to Bot Settings → Auto-Buy\n` +
          `⏰ ${sydneyTime} AEST`
        );

        console.log(`[AUTO-BUY] ✅ ${bestOpportunity.displayPair} — ${volume} @ ${bestOpportunity.price}`);

      } catch(e) {
        console.error('[AUTO-BUY ERROR]', e.message);
        await sendTelegram(`❌ Auto-buy failed for ${bestOpportunity.displayPair}: ${e.message}`);
      }

    } else {
      // ── MANUAL PROMPT MODE (default) ─────────────────────────
      pendingBuyOpportunity = {
        pair:        bestOpportunity.pair,
        displayPair: bestOpportunity.displayPair,
        sym:         bestOpportunity.sym,
        price:       bestOpportunity.price,
        amountAUD:   suggestedAUD,
        volume,
        rsi:         bestOpportunity.rsi,
        confidence:  bestOpportunity.confidence,
        timestamp:   Date.now(),
      };

      const autoBuyNote = botConfig.autoBuy
        ? `\n⚠️ Auto-buy active but confidence (${bestOpportunity.confidence}%) below threshold (${botConfig.autoBuyMinConfidence}%) — manual prompt sent`
        : '';

      await sendTelegram(
        `🟢 <b>BUY OPPORTUNITY DETECTED!</b>\n\n` +
        `<b>${bestOpportunity.displayPair}</b>\n` +
        `Price: ${fmtAUDServer(bestOpportunity.price, bestOpportunity.pair)}\n` +
        `RSI: ${bestOpportunity.rsi} | Score: ${bestOpportunity.weightedScore} | Confidence: ${bestOpportunity.confidence}%\n` +
        `24h Change: ${bestOpportunity.change24h > 0 ? '+' : ''}${bestOpportunity.change24h}%\n` +
        `High: ${fmtAUDServer(bestOpportunity.high, bestOpportunity.pair)} | Low: ${fmtAUDServer(bestOpportunity.low, bestOpportunity.pair)}` +
        `${patStr}${sentStr}${visStr}\n\n` +
        `💰 Suggested: <b>${fmtAUDServer(suggestedAUD, bestOpportunity.pair)}</b> (25% of your ${pairCurr} cash)\n` +
        `= ${volume} ${bestOpportunity.sym}\n\n` +
        `Reply <b>YES</b> to buy now or <b>NO</b> to skip.\n` +
        `⏰ Expires in 10 minutes — ${sydneyTime} AEST${autoBuyNote}`
      );

      console.log(`[BUY OPPORTUNITY] ${bestOpportunity.displayPair} RSI:${bestOpportunity.rsi} Conf:${bestOpportunity.confidence}% — prompt sent`);
    }

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

setInterval(async () => {
  try { await checkPriceAlerts(); }
  catch(e) { console.error('[ALERTS] Interval error:', e.message); }
}, 60000);

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
      '🤖 <b>KRAKN·AI v4.0 Assistant</b>\n\n' +
      'Commands I understand:\n\n' +
      '📊 <b>Market signals</b>\n' +
      '• "Any signals?" / "Scan the market"\n' +
      '• "Any opportunities?" / "Check buys"\n\n' +
      '📸 <b>Chart analysis (NEW!)</b>\n' +
      '• "Chart BTC" — renders live chart + AI vision\n' +
      '• "Chart ETH" / "Show SOL chart"\n' +
      '• "Snap XRP" — snapshot with pattern detection\n\n' +
      '🔍 <b>Coin specific</b>\n' +
      '• "How is BTC looking?"\n' +
      '• "Should I buy ETH?"\n\n' +
      '📈 <b>Portfolio</b>\n' +
      '• "What\'s my portfolio worth?"\n' +
      '• "How am I tracking?"\n\n' +
      '⚡ <b>Actions</b>\n' +
      '• "Run analysis" — full market update\n' +
      '• YES / NO — reply to buy prompts\n\n' +
      '💡 Or just ask me anything in plain English!'
    );
    return;
  }

  // ── Chart snapshot command ────────────────────────────────────
  const chartCmds = ['chart','send chart','show chart','snap','snapshot','/chart'];
  const chartMatch = chartCmds.some(c => msg.includes(c));
  const pairFromMsg = [...AUD_PAIRS, ...USD_PAIRS].find(p => {
    const sym = PAIR_DISPLAY[p]?.replace('/AUD','').replace('/USD','').toLowerCase();
    return msg.includes(sym);
  }) || selectedPairForChat || 'XBTAUD';

  if (chartMatch || msg.match(/chart (btc|eth|sol|xrp|ada|ltc|dot|link)/)) {
    const pair = pairFromMsg;
    const dp   = PAIR_DISPLAY[pair] || pair;
    await sendTelegramTo(chatId, `📸 Rendering ${dp} chart and running vision analysis...`);
    try {
      // Render and send all 5 timeframes as a photo album
      const tfConfigs = [
        { key:'15m', interval:15,   candles:80,  label:'15-Min' },
        { key:'1h',  interval:60,   candles:60,  label:'1-Hour' },
        { key:'4h',  interval:240,  candles:60,  label:'4-Hour' },
        { key:'1d',  interval:1440, candles:30,  label:'Daily'  },
        { key:'1w',  interval:10080,candles:20,  label:'Weekly' },
      ];

      const signal = await computeSignalForPair(pair);
      const vision = signal.vision;
      const ticker = await fetchSingleTicker(pair);

      // Build summary caption
      const visionLines = Object.entries(signal.visionAll || {})
        .filter(([,v]) => v?.visualPattern)
        .map(([tf,v]) => `${tf.toUpperCase()}: ${v.visualPattern} → ${v.visionAction} ${v.visionConfidence}%`)
        .join('\n');

      const summaryCaption =
        `📊 <b>${dp} — ${fmtAUDServer(ticker?.price || 0)}</b>\n\n` +
        `${signal.action==='BUY'?'🟢':signal.action==='SELL'?'🔴':'🟡'} <b>${signal.action}</b> ${signal.confidence}% | RSI: ${signal.rsi} | Score: ${signal.weightedScore}\n\n` +
        `👁 <b>Vision Analysis (5 Timeframes)</b>\n${visionLines || 'No clear patterns detected'}`;

      // Send each chart as a separate photo with its own caption
      for (const tf of tfConfigs) {
        try {
          const ohlc    = await krakenPublicRequest('OHLC', { pair, interval: tf.interval });
          const k       = Object.keys(ohlc).find(k => k !== 'last');
          const candles = ohlc[k].slice(-tf.candles);
          const buf     = renderChartToBuffer(candles, 600, 300);
          if (!buf) continue;

          const tfVision = signal.visionAll?.[tf.key];
          const caption  = tf.key === '15m' ? summaryCaption :
            `📊 <b>${dp} ${tf.label}</b>\n` +
            (tfVision ? `👁 ${tfVision.visualPattern} → ${tfVision.visionAction} ${tfVision.visionConfidence}%\n${tfVision.keyObservation}` : 'Analysing...');

          const boundary = '----FB' + Date.now() + tf.key;
          const chunks   = [];
          const field    = (n,v) => chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`));
          field('chat_id', chatId);
          field('parse_mode', 'HTML');
          field('caption', caption);
          chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${dp.replace('/','_')}_${tf.key}.png"\r\nContent-Type: image/png\r\n\r\n`));
          chunks.push(buf);
          chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
          const body = Buffer.concat(chunks);

          await new Promise((resolve, reject) => {
            const r = https.request({
              hostname: 'api.telegram.org',
              path: `/bot${TELEGRAM_TOKEN}/sendPhoto`,
              method: 'POST',
              headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
            }, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve()); });
            r.on('error', reject); r.write(body); r.end();
          });

          // Small delay between photos to avoid Telegram rate limiting
          await new Promise(r => setTimeout(r, 500));
        } catch(e) { console.warn(`[CHART ${tf.key}] Failed:`, e.message); }
      }

      console.log(`[CHART TELEGRAM] Sent all 5 ${dp} charts to ${chatId}`);
    } catch(e) {
      await sendTelegramTo(chatId, `❌ Chart failed: ${e.message}`);
    }
    return;
  }

  // ── Smart money scan command ──────────────────────────────────
  if (msg.includes('smart money') || msg.includes('whale wallets') || msg.includes('wallet scan') || msg === '/wallets') {
    await sendTelegramTo(chatId, `🐋 Scanning ${smartWallets.filter(w=>w.active).length} smart money wallets... give me 30 seconds!`);
    try {
      await checkSmartMoneySignals();
      const recent = smartMoneyAlertLog.slice(0, 3);
      if (!recent.length) {
        await sendTelegramTo(chatId, '🔍 Scan complete — no significant activity detected in the last 2 hours. All wallets checked.');
      }
    } catch(e) {
      await sendTelegramTo(chatId, '❌ Scan failed: ' + e.message);
    }
    return;
  }

  if (msg === 'run analysis' || msg === '/analysis' || msg === 'analyse' || msg === 'analyze') {
    await sendTelegramTo(chatId, '⏳ Running full market analysis... give me 30 seconds!');
    await runAdvisor();
    return;
  }

  // ── Signal check phrases ────────────────────────────────────
  const signalPhrases = [
    'any signals', 'are there any signals', 'signals', 'check signals',
    'any trades', 'should i trade', 'what should i do', 'anything to buy',
    'anything to sell', 'buy signals', 'sell signals', 'check the market',
    'market check', 'whats the market doing', "what's the market doing",
    'scan', 'scan market', 'run signals', '/signals', '/scan',
    'good time to buy', 'good time to sell', 'any opportunities',
    'check opportunities', 'opportunities',
  ];

  if (signalPhrases.some(p => msg.includes(p))) {
    await sendTelegramTo(chatId, '🔍 Scanning all markets for signals... give me 20 seconds!');
    try {
      const fearGreed = await fetchFearGreed();
      const fgStr     = fearGreed.value ? `😱 Fear & Greed: ${fearGreed.value}/100 (${fearGreed.label})\n\n` : '';
      const results   = [];

      // Limit to 4 pairs in Telegram scan to avoid timeout
      const scanPairs = getActivePairs(botConfig.currencyMode).slice(0, 4);

      for (const pair of scanPairs) {
        try {
          const signal  = await computeSignalForPair(pair);
          await new Promise(r => setTimeout(r, 500)); // stagger
          const ticker  = await fetchSingleTicker(pair);
          const dp      = PAIR_DISPLAY[pair] || pair;
          const sym     = dp.replace('/AUD','').replace('/USD','');
          const sent    = sentimentCache[sym] || { score:0, label:'Unknown' };
          const topPat  = signal.patterns?.[0];

          const emoji   = signal.action === 'BUY'  ? '🟢' :
                          signal.action === 'SELL' ? '🔴' : '🟡';

          results.push(
            `${emoji} <b>${dp}</b> — ${fmtAUDServer(ticker?.price || 0, pair)}\n` +
            `${signal.action} ${signal.confidence}% | Score: ${signal.weightedScore} | RSI: ${signal.rsi}\n` +
            `Sentiment: ${sent.score}/10 (${sent.label})\n` +
            (topPat ? `Pattern: ${topPat.name} — ${topPat.signal}\n` : '') +
            (signal.signals?.length ? `Signals: ${signal.signals.slice(0,2).join(', ')}` : 'No strong signals')
          );
        } catch(e) { console.warn(`[SIGNAL SCAN] ${pair}:`, e.message); }
      }

      const summary = results.length
        ? `🤖 <b>KRAKN·AI Signal Scan</b>\n\n${fgStr}${results.join('\n\n')}\n\n💡 Checking for buy opportunities...`
        : '⚠️ Could not fetch signals. Try again in a moment.';

      await sendTelegramTo(chatId, summary);
      await checkBuyOpportunity();

    } catch(e) {
      await sendTelegramTo(chatId, '❌ Signal scan failed: ' + e.message);
    }
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
      const valueAUD = (parseFloat(freshVolume) * freshPrice).toFixed(2);

      // ── Record buy immediately for P&L and hold time ──────
      recordTrade(opp.pair, opp.sym, 'buy', freshVolume, freshPrice, 'manual-yes');
      lastBuyTimes[opp.sym] = Date.now(); // enforce minimum hold time from now

      const sydneyTime = new Date().toLocaleString('en-AU', { timeZone:'Australia/Sydney', dateStyle:'short', timeStyle:'short' });
      await sendTelegramTo(chatId,
        `🟢 <b>BUY ORDER PLACED!</b>\n\n` +
        `<b>${opp.displayPair}</b>\n` +
        `Bought: ${freshVolume} ${opp.sym}\n` +
        `Price: ${fmtAUDServer(freshPrice)}\n` +
        `Total: ≈ ${fmtAUDServer(parseFloat(valueAUD))}\n` +
        `TXID: ${order.txid?.join(', ')}\n` +
        `⏱ Min hold: ${botConfig.minHoldMinutes} minutes\n\n` +
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
    status: 'online', version: "4.0",
    keysConfigured: !!(KRAKEN_API_KEY && KRAKEN_API_SECRET),
    aiConfigured: !!(process.env.ANTHROPIC_API_KEY),
    telegramConfigured: !!(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID),
    advisorEnabled: advisorSettings.enabled,
    advisorInterval: advisorSettings.intervalHours,
    currency: 'AUD',
    dataFile: DATA_FILE,
    timestamp: new Date().toISOString()
  });
});

// Export current config — paste the configString into Railway as SAVED_CONFIG env var
app.get('/api/config/export', requireAuth, (req, res) => {
  res.json({
    success: true,
    message: 'Copy configString and paste into Railway as SAVED_CONFIG environment variable',
    configString: JSON.stringify({ botConfig, advisorSettings, dcaConfig }),
    current: { botConfig, advisorSettings, dcaConfig },
  });
});

app.get('/api/ticker', async (req, res) => {
  try {
    const mode         = botConfig.currencyMode || 'AUD';
    const activePairs  = getActivePairs(mode);
    const requestedPairs = (req.query.pairs || activePairs.join(',')).split(',');
    const tickers = {};
    await Promise.all(requestedPairs.map(async (pair) => {
      const data = await fetchSingleTicker(pair.trim());
      if (data) tickers[pair.trim()] = { ...data, currency: pairCurrency(pair.trim()) };
    }));
    res.json({ success: true, data: tickers, mode, currency: mode });
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

    const fearGreed   = await fetchFearGreed();
    const fgNote      = fearGreed.value ? `Fear & Greed: ${fearGreed.value}/100 (${fearGreed.label})` : '';

    // Sprint 1: sentiment + patterns + pre-computed multi-timeframe signal
    const coinSym     = displayPair.replace('/AUD','');
    const sentiment   = await fetchSentimentScore(coinSym);
    const mtSignal    = await computeSignalForPair(pair);
    const patternList = mtSignal.patterns?.length
      ? mtSignal.patterns.map(p => `${p.name} (${p.tf}): ${p.desc}`).join('; ')
      : 'None detected';

    const prompt = `You are a crypto trading AI for an Australian retail investor.
All prices are in Australian Dollars (AUD). Do NOT mention USD conversion.

FULL MARKET ANALYSIS FOR ${displayPair}:
Price: ${fmtAUDServer(parseFloat(price))} (${change24h > 0 ? '+' : ''}${change24h}% 24h)
${balanceNote}

TECHNICAL INDICATORS (multi-timeframe):
- Weighted signal score: ${mtSignal.weightedScore} → ${mtSignal.action} at ${mtSignal.confidence}% confidence
- RSI (1h): ${mtSignal.rsi} | MACD: ${mtSignal.timeframes?.['1h']?.macd || 'N/A'} | BB: ${mtSignal.timeframes?.['1h']?.bb || 'N/A'}
- Key signals: ${mtSignal.signals?.slice(0,4).join(', ') || 'None'}
- Candlestick patterns: ${patternList}

SENTIMENT:
- ${fgNote}
- Social sentiment: ${sentiment.score}/10 (${sentiment.label})${sentiment.reasons.length ? ' — ' + sentiment.reasons[0] : ''}

Return ONLY this JSON (no markdown):
{
  "action": "BUY",
  "confidence": 72,
  "reason": "Brief 1-2 sentence reason covering technicals AND sentiment",
  "support": 150000,
  "resistance": 165000,
  "risk": "Medium",
  "rsi": ${mtSignal.rsi},
  "rsi_signal": "Neutral",
  "macd": "Bullish",
  "trend": "Uptrend",
  "topPattern": "${mtSignal.patterns?.[0]?.name || 'None'}",
  "sentimentScore": ${sentiment.score},
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
  saveData(); // persist
  res.json({ success: true, data: advisorSettings });
});
app.post('/api/advisor/run', requireAuth, async (req, res) => {
  res.json({ success: true, message: 'Running — check Telegram in ~30 seconds!' });
  runAdvisor();
});

// Manual buy check trigger — forces immediate check without waiting for hourly timer
app.post('/api/buycheck/run', requireAuth, async (req, res) => {
  res.json({ success: true, message: 'Running buy check now — check Telegram!' });
  checkBuyOpportunity();
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
      '🤖 <b>KRAKN·AI v4.0 Connected!</b>\n\n' +
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
      // Get current price for P&L recording
      try {
        const ticker = await fetchSingleTicker(pair);
        if (ticker) {
          const sym = dp.replace('/AUD','');
          recordTrade(pair, sym, type, volume, price || ticker.price, 'manual');
        }
      } catch(e) {}
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

// ─── P&L Routes ────────────────────────────────────────────────
app.get('/api/pnl', requireAuth, async (req, res) => {
  try {
    // Only seed from Kraken history if we have NO data at all
    // Important: we only seed BUY trades to establish avg buy price
    // Seeding sells causes phantom P&L calculations
    if (Object.keys(pnlByAsset).length === 0 && KRAKEN_API_KEY && KRAKEN_API_SECRET) {
      try {
        const history = await krakenPrivateRequest('TradesHistory');
        const trades  = Object.values(history.trades || {})
          .sort((a,b) => a.time - b.time) // oldest first
          .slice(0, 50); // limit to recent 50

        for (const t of trades) {
          if (t.type !== 'buy') continue; // ONLY buys for seeding
          const sym = (t.pair||'').replace('AUD','').replace(/^X/,'').replace(/Z$/,'').replace('XBT','BTC');
          if (!sym || sym === 'AUD') continue;
          const vol   = parseFloat(t.vol)   || 0;
          const price = parseFloat(t.price) || 0;
          if (vol <= 0 || price <= 0) continue;
          // Only initialise — don't use recordTrade which triggers saveData repeatedly
          if (!pnlByAsset[sym]) pnlByAsset[sym] = { avgBuyPrice:0, totalVolume:0, totalCost:0, realisedPnl:0, tradeCount:0 };
          const a = pnlByAsset[sym];
          const newCost   = a.totalCost + (vol * price);
          const newVol    = a.totalVolume + vol;
          a.avgBuyPrice   = newCost / newVol;
          a.totalCost     = newCost;
          a.totalVolume   = newVol;
          a.tradeCount++;
        }

        // Now cap totalVolume to what's actually held on Kraken right now
        // This prevents phantom P&L from old sold positions
        try {
          const balance = await krakenPrivateRequest('Balance');
          for (const [sym, data] of Object.entries(pnlByAsset)) {
            const krakenKey = Object.keys(balance).find(k =>
              k.replace(/^X/,'').replace(/Z$/,'').replace('XBT','BTC') === sym
            );
            const actualHeld = krakenKey ? parseFloat(balance[krakenKey]) : 0;
            if (actualHeld <= 0) {
              // Not holding this anymore — zero it out to avoid phantom P&L
              data.totalVolume = 0;
              data.totalCost   = 0;
            } else {
              // Cap to what's actually held
              data.totalVolume = Math.min(data.totalVolume, actualHeld);
              data.totalCost   = data.avgBuyPrice * data.totalVolume;
            }
          }
        } catch(e) { console.warn('[P&L] Balance cap failed:', e.message); }

        console.log('[P&L] Seeded from Kraken history — buy trades only, capped to actual holdings');
        saveData();
      } catch(e) { console.warn('[P&L] Could not seed from Kraken history:', e.message); }
    }

    // Calculate totals — only for assets we actually hold
    let totalRealisedPnl   = 0;
    let totalUnrealisedPnl = 0;
    const assetSummary     = [];

    for (const [sym, data] of Object.entries(pnlByAsset)) {
      totalRealisedPnl += data.realisedPnl || 0;
      if (data.totalVolume <= 0 || data.avgBuyPrice <= 0) continue; // skip if not holding
      const pair = AUD_PAIRS.find(p => p.includes(sym === 'BTC' ? 'XBT' : sym));
      if (!pair) continue;
      try {
        const ticker = await fetchSingleTicker(pair);
        if (!ticker) continue;
        const unreal = getUnrealisedPnl(sym, ticker.price, data.totalVolume);
        // Sanity check — unrealised P&L should never be more than 10x the portfolio value
        if (Math.abs(unreal.unrealisedPnl) > 1000000) {
          console.warn(`[P&L] Suspicious unrealised P&L for ${sym}: ${unreal.unrealisedPnl} — skipping`);
          continue;
        }
        totalUnrealisedPnl += unreal.unrealisedPnl;
        assetSummary.push({
          sym,
          avgBuyPrice:   parseFloat(data.avgBuyPrice.toFixed(4)),
          currentPrice:  ticker.price,
          volume:        data.totalVolume,
          realisedPnl:   parseFloat((data.realisedPnl||0).toFixed(2)),
          unrealisedPnl: parseFloat(unreal.unrealisedPnl.toFixed(2)),
          pnlPct:        parseFloat(unreal.pnlPct.toFixed(2)),
          tradeCount:    data.tradeCount,
        });
      } catch(e) { console.warn(`[P&L] Ticker fetch failed for ${sym}:`, e.message); }
    }

    res.json({
      success: true,
      data: {
        totalRealisedPnl:   parseFloat(totalRealisedPnl.toFixed(2)),
        totalUnrealisedPnl: parseFloat(totalUnrealisedPnl.toFixed(2)),
        totalPnl:           parseFloat((totalRealisedPnl + totalUnrealisedPnl).toFixed(2)),
        assetSummary,
        recentTrades: tradeLog.slice(-20).reverse(),
        tradeCount:   tradeLog.length,
      }
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Reset P&L data — clears corrupted history and starts fresh
app.post('/api/pnl/reset', requireAuth, (req, res) => {
  pnlByAsset = {};
  tradeLog   = [];
  saveData();
  console.log('[P&L] Reset by user — starting fresh');
  res.json({ success: true, message: 'P&L data reset. Will re-seed from Kraken on next load.' });
});
app.get('/api/stoploss', requireAuth, (req, res) => {
  res.json({ success: true, data: { enabled: botConfig.stopLossEnabled, dropPct: botConfig.stopLossPct, trailing: botConfig.trailingStop } });
});
app.post('/api/stoploss', requireAuth, (req, res) => {
  if (req.body.enabled !== undefined) botConfig.stopLossEnabled = req.body.enabled;
  if (req.body.dropPct !== undefined) botConfig.stopLossPct     = parseFloat(req.body.dropPct);
  if (req.body.trailing !== undefined) botConfig.trailingStop   = req.body.trailing;
  saveData(); // persist
  res.json({ success: true, data: { enabled: botConfig.stopLossEnabled, dropPct: botConfig.stopLossPct, trailing: botConfig.trailingStop } });
});

// ─── Australian Tax CSV Export ─────────────────────────────────
app.get('/api/tax/export', requireAuth, async (req, res) => {
  try {
    // Seed from Kraken history if needed
    let allTrades = [...tradeLog];
    if (allTrades.length === 0 && KRAKEN_API_KEY) {
      try {
        const history = await krakenPrivateRequest('TradesHistory');
        const trades  = Object.values(history.trades || {});
        for (const t of trades) {
          const sym = (t.pair||'').replace('AUD','').replace(/^X/,'').replace(/Z$/,'').replace('XBT','BTC');
          if (sym) allTrades.push({
            timestamp: new Date(t.time*1000).toISOString(),
            sym, type: t.type,
            volume: parseFloat(t.vol),
            price:  parseFloat(t.price),
            valueAUD: parseFloat(t.cost),
            source: 'kraken-history',
          });
        }
      } catch(e) { console.warn('[TAX] Could not load Kraken history:', e.message); }
    }

    // Sort by date
    allTrades.sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));

    // Build CSV — ATO-compatible format
    const rows = [
      ['Date','Asset','Buy/Sell','Quantity','Price (AUD)','Total (AUD)','Fee (AUD)','Source','Notes']
    ];
    for (const t of allTrades) {
      const d = new Date(t.timestamp);
      const dateStr = `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getFullYear()}`;
      rows.push([
        dateStr,
        t.sym || '',
        (t.type||'').toUpperCase(),
        (t.volume||0).toFixed(8),
        (t.price||0).toFixed(4),
        (t.valueAUD||0).toFixed(2),
        '0.00', // Kraken fees not tracked separately yet
        t.source || 'krakn-ai',
        '',
      ]);
    }

    const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
    const year = new Date().getFullYear();
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="krakn-ai-trades-${year}.csv"`);
    res.send(csv);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── Portfolio Performance History ─────────────────────────────
async function recordPortfolioSnapshot() {
  if (!KRAKEN_API_KEY || !KRAKEN_API_SECRET) return;
  try {
    const bal = await krakenPrivateRequest('Balance');
    let total = 0;
    for (const [asset, qty] of Object.entries(bal)) {
      const q = parseFloat(qty);
      if (q <= 0) continue;
      if (['ZAUD','AUD','AUDX'].includes(asset)) { total += q; continue; }
      if (['ZUSD','USD'].includes(asset)) { total += q * 1.55; continue; }
      const sym  = asset.replace(/^X/,'').replace(/Z$/,'').replace('XBT','BTC');
      const pair = sym === 'BTC' ? 'XBTAUD' : sym+'AUD';
      try {
        const tk = await fetchSingleTicker(pair);
        if (tk) total += q * tk.price;
      } catch(e) {}
    }
    const today = new Date().toISOString().slice(0,10);
    // Only one snapshot per day
    const existing = portfolioHistory.findIndex(h => h.date === today);
    if (existing >= 0) portfolioHistory[existing].valueAUD = Math.round(total);
    else portfolioHistory.push({ date: today, valueAUD: Math.round(total), timestamp: new Date().toISOString() });
    // Keep 90 days
    if (portfolioHistory.length > 90) portfolioHistory = portfolioHistory.slice(-90);
    saveData();
  } catch(e) { console.warn('[PORTFOLIO HISTORY]', e.message); }
}

app.get('/api/portfolio/history', requireAuth, (req, res) => {
  res.json({ success: true, data: portfolioHistory });
});

// ─── Currency Mode ─────────────────────────────────────────────
app.get('/api/currency/mode', requireAuth, (req, res) => {
  res.json({ success: true, data: {
    mode:       botConfig.currencyMode || 'AUD',
    audPairs:   AUD_PAIRS.length,
    usdPairs:   USD_PAIRS.length,
    activePairs: getActivePairs(botConfig.currencyMode).length,
  }});
});

app.post('/api/currency/mode', requireAuth, (req, res) => {
  const { mode } = req.body;
  if (!['AUD','USD','BOTH'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be AUD, USD or BOTH' });
  }
  botConfig.currencyMode = mode;
  saveData();
  const active = getActivePairs(mode);
  console.log(`[CURRENCY] Mode set to ${mode} — watching ${active.length} pairs`);
  res.json({ success: true, data: {
    mode,
    activePairs:  active.length,
    pairs:        active.map(p => PAIR_DISPLAY[p] || p),
  }});
});

// ══════════════════════════════════════════════════════════════
// SMART MONEY WALLET TRACKING — Tier 3
// Monitors known profitable on-chain wallets and fires alerts
// when they buy/sell coins that KRAKN·AI is also watching
// ══════════════════════════════════════════════════════════════

// ─── Known Smart Money Wallets — pre-seeded defaults ──────────
// (loaded from saved data on startup, overrides defaults if user has modified)

// ─── Coin address mapping for known tokens ────────────────────
const TOKEN_ADDRESSES = {
  ethereum: {
    ETH:  'native',
    LINK: '0x514910771af9ca656af840dff83e8264ecf986ca',
    UNI:  '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
    AAVE: '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9',
    MATIC:'0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0',
    LINK: '0x514910771af9ca656af840dff83e8264ecf986ca',
  }
};

// Map coin symbols to chains for smart money lookup
const COIN_CHAINS = {
  BTC:'bitcoin', ETH:'ethereum', LINK:'ethereum', UNI:'ethereum',
  AAVE:'ethereum', MATIC:'ethereum', SOL:'solana', AVAX:'avalanche',
};

// ─── Fetch wallet transactions from free APIs ─────────────────
async function fetchWalletTransactions(wallet) {
  const cached = smartMoneyCache[wallet.id];
  if (cached && (Date.now() - cached.fetchedAt) < 10 * 60 * 1000) return cached.txs;

  try {
    let txs = [];

    if (wallet.chain === 'ethereum') {
      // Etherscan free API — no key needed for basic queries (5/sec limit)
      const url = `https://api.etherscan.io/api?module=account&action=txlist&address=${wallet.address}&startblock=0&endblock=99999999&page=1&offset=10&sort=desc`;
      const res  = await fetch(url, { headers:{ 'User-Agent':'KRAKN-AI/4.0' } });
      const data = await res.json();
      if (data.status === '1' && Array.isArray(data.result)) {
        txs = data.result.slice(0, 10).map(tx => ({
          hash:      tx.hash,
          timestamp: parseInt(tx.timeStamp) * 1000,
          from:      tx.from?.toLowerCase(),
          to:        tx.to?.toLowerCase(),
          value:     parseFloat(tx.value) / 1e18, // ETH
          valueUSD:  (parseFloat(tx.value) / 1e18) * 3000, // approx
          type:      tx.from?.toLowerCase() === wallet.address.toLowerCase() ? 'out' : 'in',
          chain:     'ethereum',
        }));
      }

      // Also fetch ERC20 token transfers
      const tokenUrl = `https://api.etherscan.io/api?module=account&action=tokentx&address=${wallet.address}&page=1&offset=15&sort=desc`;
      const tokenRes  = await fetch(tokenUrl, { headers:{ 'User-Agent':'KRAKN-AI/4.0' } });
      const tokenData = await tokenRes.json();
      if (tokenData.status === '1' && Array.isArray(tokenData.result)) {
        const tokenTxs = tokenData.result.slice(0, 15).map(tx => ({
          hash:       tx.hash,
          timestamp:  parseInt(tx.timeStamp) * 1000,
          from:       tx.from?.toLowerCase(),
          to:         tx.to?.toLowerCase(),
          tokenName:  tx.tokenName,
          tokenSymbol:tx.tokenSymbol?.toUpperCase(),
          value:      parseFloat(tx.value) / Math.pow(10, parseInt(tx.tokenDecimal)),
          valueUSD:   0, // will be estimated later
          type:       tx.from?.toLowerCase() === wallet.address.toLowerCase() ? 'sell' : 'buy',
          chain:      'ethereum',
          isToken:    true,
        }));
        txs = [...txs, ...tokenTxs];
      }

    } else if (wallet.chain === 'solana') {
      // Solscan free API
      const url = `https://public-api.solscan.io/account/transactions?account=${wallet.address}&limit=10`;
      const res  = await fetch(url, { headers:{ 'User-Agent':'KRAKN-AI/4.0' } });
      const data = await res.json();
      if (Array.isArray(data)) {
        txs = data.slice(0, 10).map(tx => ({
          hash:      tx.txHash,
          timestamp: (tx.blockTime || Date.now()/1000) * 1000,
          value:     (tx.fee || 0) / 1e9,
          type:      'unknown',
          chain:     'solana',
        }));
      }

    } else if (wallet.chain === 'bitcoin') {
      // Blockchain.info free API
      const url = `https://blockchain.info/rawaddr/${wallet.address}?limit=5`;
      const res  = await fetch(url, { headers:{ 'User-Agent':'KRAKN-AI/4.0' } });
      const data = await res.json();
      if (data.txs) {
        txs = data.txs.slice(0, 5).map(tx => ({
          hash:      tx.hash,
          timestamp: (tx.time || 0) * 1000,
          value:     tx.result / 1e8, // BTC
          valueUSD:  (tx.result / 1e8) * 90000, // approx
          type:      tx.result > 0 ? 'in' : 'out',
          chain:     'bitcoin',
        }));
      }
    }

    // Filter to only recent transactions (last 24 hours)
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recent = txs.filter(tx => tx.timestamp > oneDayAgo);

    smartMoneyCache[wallet.id] = { txs: recent, fetchedAt: Date.now() };
    return recent;

  } catch(e) {
    console.warn(`[SMART MONEY] Fetch failed for ${wallet.label}:`, e.message);
    return [];
  }
}

// ─── Claude interprets the wallet move ───────────────────────
async function interpretWalletMove(wallet, txs, currentSignals) {
  if (!txs.length) return null;
  try {
    // Build a summary of what the wallet did
    const txSummary = txs.slice(0, 5).map(tx => {
      if (tx.isToken) return `${tx.type.toUpperCase()} ${tx.tokenSymbol} (${tx.value.toFixed(2)} tokens)`;
      return `${tx.type.toUpperCase()} ${tx.value.toFixed(4)} ${tx.chain === 'bitcoin' ? 'BTC' : tx.chain === 'solana' ? 'SOL' : 'ETH'} ($${(tx.valueUSD||0).toFixed(0)})`;
    }).join(', ');

    // What coins are we watching that this wallet touched?
    const relevantCoins = [...new Set(
      txs.filter(tx => tx.isToken).map(tx => tx.tokenSymbol)
         .filter(sym => Object.keys(COIN_CHAINS).includes(sym))
    )];

    const currentSignalSummary = currentSignals
      .filter(s => relevantCoins.includes(s.sym) || txs.some(tx => tx.chain === COIN_CHAINS[s.sym]))
      .map(s => `${s.sym}: ${s.action} ${s.confidence}% (RSI ${s.rsi})`)
      .join(', ');

    const prompt = `You are a crypto trading analyst interpreting on-chain wallet activity.

WALLET: ${wallet.label} (Win Rate: ${(wallet.winRate*100).toFixed(0)}%)
Chain: ${wallet.chain}
Recent transactions (last 24h): ${txSummary || 'No activity'}
Tags: ${wallet.tags.join(', ')}

KRAKN·AI current signals for relevant coins: ${currentSignalSummary || 'No matching coins active'}

Determine if this wallet activity represents a meaningful trading signal.

Return ONLY this JSON (no markdown):
{
  "isSignificant": true,
  "action": "BUY",
  "coin": "ETH",
  "confidence": 74,
  "reasoning": "One sentence explanation",
  "isNoise": false,
  "noiseReason": null,
  "urgency": "HIGH"
}

isSignificant: true only if this is a real trading signal (not internal transfer, not dust)
action: BUY if wallet is accumulating, SELL if distributing, HOLD if unclear
coin: which coin the signal is strongest for
confidence: 0-99
isNoise: true if this is likely an internal transfer, exchange rebalancing, or non-market-impacting move
urgency: HIGH/MEDIUM/LOW based on size and timing
If isNoise is true, set isSignificant to false.`;

    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 20000);
    const response   = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    clearTimeout(timeout);

    const data   = await response.json();
    const text   = (data.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('');
    const match  = text.match(/\{[\s\S]*?\}/);
    if (!match) return null;
    return JSON.parse(match[0]);

  } catch(e) {
    console.warn('[SMART MONEY] Interpret failed:', e.message);
    return null;
  }
}

// ─── Main Smart Money Scanner ─────────────────────────────────
async function checkSmartMoneySignals() {
  if (!smartMoneyEnabled) return;
  const activeWallets = smartWallets.filter(w => w.active);
  if (!activeWallets.length) return;

  console.log(`[SMART MONEY] Scanning ${activeWallets.length} wallets...`);

  // Build current signal context for all active pairs
  const currentSignals = [];
  for (const pair of getActivePairs(botConfig.currencyMode).slice(0, 8)) {
    try {
      const ticker = await fetchSingleTicker(pair);
      if (!ticker) continue;
      const sym    = (PAIR_DISPLAY[pair]||pair).replace('/AUD','').replace('/USD','');
      // Use cached signal if available, avoid redundant compute
      currentSignals.push({ pair, sym, price: ticker.price, action:'HOLD', confidence:50, rsi:50 });
    } catch(e) {}
  }

  // Check each wallet with staggered timing to avoid rate limits
  for (let i = 0; i < activeWallets.length; i++) {
    const wallet = activeWallets[i];
    try {
      // Stagger requests by 2s each
      if (i > 0) await new Promise(r => setTimeout(r, 2000));

      const txs = await fetchWalletTransactions(wallet);
      if (!txs.length) continue;

      // Only interpret if there's recent activity (last 2 hours)
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      const freshTxs    = txs.filter(tx => tx.timestamp > twoHoursAgo);
      if (!freshTxs.length) continue;

      // Check if we already alerted on these transactions
      const txHashes  = freshTxs.map(tx => tx.hash);
      const alreadyAlerted = txHashes.some(h =>
        smartMoneyAlertLog.some(a => a.txHashes?.includes(h))
      );
      if (alreadyAlerted) continue;

      console.log(`[SMART MONEY] ${wallet.label} has ${freshTxs.length} fresh transactions`);

      const interpretation = await interpretWalletMove(wallet, freshTxs, currentSignals);
      if (!interpretation) continue;
      if (!interpretation.isSignificant || interpretation.isNoise) {
        console.log(`[SMART MONEY] ${wallet.label} — noise: ${interpretation.noiseReason || 'routine activity'}`);
        continue;
      }

      // Find matching KRAKN·AI signal for the coin
      const coinSignal = currentSignals.find(s => s.sym === interpretation.coin);
      const kraken_confirms = coinSignal?.action === interpretation.action;

      // Build Telegram message
      const actionEmoji = interpretation.action === 'BUY' ? '🟢' : interpretation.action === 'SELL' ? '🔴' : '🟡';
      const urgencyEmoji = interpretation.urgency === 'HIGH' ? '🚨' : interpretation.urgency === 'MEDIUM' ? '⚡' : '📊';

      const msg =
        `${urgencyEmoji} <b>SMART MONEY ALERT</b>\n\n` +
        `👛 <b>${wallet.label}</b>\n` +
        `Win Rate: ${(wallet.winRate*100).toFixed(0)}% | Chain: ${wallet.chain}\n\n` +
        `${actionEmoji} <b>${interpretation.action} ${interpretation.coin}</b>\n` +
        `Confidence: ${interpretation.confidence}%\n` +
        `${interpretation.reasoning}\n\n` +
        `${kraken_confirms
          ? `✅ <b>KRAKN·AI CONFIRMS</b> — technical signal agrees\nCombined signal: STRONG ${interpretation.action}`
          : `⚠️ KRAKN·AI signal: ${coinSignal?.action || 'HOLD'} — use caution`
        }\n\n` +
        `Urgency: ${interpretation.urgency} | ${freshTxs.length} transactions in last 2h\n` +
        `⏰ ${new Date().toLocaleString('en-AU', {timeZone:'Australia/Sydney', dateStyle:'short', timeStyle:'short'})} AEST`;

      await sendTelegram(msg);

      // Log the alert
      smartMoneyAlertLog.unshift({
        walletId:    wallet.id,
        walletLabel: wallet.label,
        action:      interpretation.action,
        coin:        interpretation.coin,
        confidence:  interpretation.confidence,
        txHashes,
        timestamp:   Date.now(),
      });

      // Keep last 50 alerts
      if (smartMoneyAlertLog.length > 50) smartMoneyAlertLog = smartMoneyAlertLog.slice(0, 50);

      // If HIGH urgency and confirms KRAKN signal, trigger buy check
      if (interpretation.urgency === 'HIGH' && kraken_confirms && interpretation.action === 'BUY') {
        console.log(`[SMART MONEY] High urgency BUY confirmed — triggering buy check`);
        setTimeout(() => checkBuyOpportunity(), 3000);
      }

    } catch(e) {
      console.warn(`[SMART MONEY] Error checking ${wallet.label}:`, e.message);
    }
  }
}

// ─── Smart Money API Routes ───────────────────────────────────
app.get('/api/smartmoney/wallets', requireAuth, (req, res) => {
  res.json({ success: true, data: smartWallets, enabled: smartMoneyEnabled });
});

app.post('/api/smartmoney/wallets', requireAuth, (req, res) => {
  const { address, label, chain, winRate, tags } = req.body;
  if (!address || !label || !chain) {
    return res.status(400).json({ error: 'address, label and chain required' });
  }
  const wallet = {
    id:      'sm' + Date.now(),
    address: address.trim(),
    label:   label.trim(),
    chain:   chain.toLowerCase(),
    winRate: parseFloat(winRate) || 0.65,
    tags:    tags || [],
    active:  true,
    addedAt: new Date().toISOString(),
  };
  smartWallets.push(wallet);
  saveData();
  console.log(`[SMART MONEY] Added wallet: ${wallet.label} (${wallet.chain})`);
  res.json({ success: true, data: wallet });
});

app.delete('/api/smartmoney/wallets/:id', requireAuth, (req, res) => {
  const before = smartWallets.length;
  smartWallets  = smartWallets.filter(w => w.id !== req.params.id);
  if (smartWallets.length === before) return res.status(404).json({ error: 'Wallet not found' });
  saveData();
  res.json({ success: true });
});

app.post('/api/smartmoney/wallets/:id/toggle', requireAuth, (req, res) => {
  const wallet = smartWallets.find(w => w.id === req.params.id);
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
  wallet.active = !wallet.active;
  saveData();
  res.json({ success: true, data: wallet });
});

app.post('/api/smartmoney/toggle', requireAuth, (req, res) => {
  smartMoneyEnabled = !smartMoneyEnabled;
  console.log(`[SMART MONEY] ${smartMoneyEnabled ? 'Enabled' : 'Disabled'}`);
  res.json({ success: true, enabled: smartMoneyEnabled });
});

app.get('/api/smartmoney/alerts', requireAuth, (req, res) => {
  res.json({ success: true, data: smartMoneyAlertLog.slice(0, 20) });
});

app.post('/api/smartmoney/scan', requireAuth, async (req, res) => {
  res.json({ success: true, message: 'Smart money scan started — check Telegram!' });
  checkSmartMoneySignals();
});

// ══════════════════════════════════════════════════════════════
// FEATURE 1: MACRO EVENT CALENDAR
// Fetches high-impact economic events from ForexFactory (free)
// Alerts before Fed decisions, CPI, NFP — tightens stops automatically
// ══════════════════════════════════════════════════════════════
let macroCalendarCache  = { events:[], fetchedAt:0 };
let macroAlertedEvents  = new Set(); // track events already alerted

async function fetchMacroCalendar() {
  // Cache for 4 hours
  if (Date.now() - macroCalendarCache.fetchedAt < 4 * 60 * 60 * 1000) {
    return macroCalendarCache.events;
  }
  try {
    // ForexFactory public calendar — free, no API key
    const now     = new Date();
    const dateStr = now.toISOString().split('T')[0].replace(/-/g,'/');
    const url     = `https://nfs.faireconomy.media/ff_calendar_thisweek.json`;
    const res     = await fetch(url, { headers:{ 'User-Agent':'KRAKN-AI/4.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Filter to high-impact events only (impact === 'High')
    const highImpact = data.filter(e =>
      e.impact === 'High' &&
      ['USD','AUD','EUR','GBP','CNY'].includes(e.country)
    ).map(e => ({
      title:   e.title,
      country: e.country,
      date:    e.date,
      time:    e.time,
      impact:  e.impact,
      id:      `${e.date}_${e.title}`.replace(/\s/g,'_'),
    }));

    macroCalendarCache = { events: highImpact, fetchedAt: Date.now() };
    console.log(`[MACRO] Loaded ${highImpact.length} high-impact events this week`);
    return highImpact;
  } catch(e) {
    console.warn('[MACRO] Calendar fetch failed:', e.message);
    return macroCalendarCache.events || [];
  }
}

async function checkMacroEvents() {
  try {
    const events = await fetchMacroCalendar();
    const now    = Date.now();

    for (const event of events) {
      if (macroAlertedEvents.has(event.id)) continue;

      // Parse event time
      const eventTime = new Date(`${event.date} ${event.time}`).getTime();
      if (isNaN(eventTime)) continue;

      const minutesUntil = (eventTime - now) / 1000 / 60;

      // Alert 60 minutes before high-impact event
      if (minutesUntil > 0 && minutesUntil <= 60) {
        macroAlertedEvents.add(event.id);

        // Auto-tighten stop-loss during macro events
        const wasStopLossPct = botConfig.stopLossPct;
        const tightened      = Math.max(3, botConfig.stopLossPct - 2);

        await sendTelegram(
          `📅 <b>MACRO EVENT IN ${Math.round(minutesUntil)} MINUTES</b>\n\n` +
          `📊 <b>${event.title}</b>\n` +
          `Country: ${event.country} | Impact: 🔴 HIGH\n` +
          `Time: ${event.time} (UTC)\n\n` +
          `⚠️ High-impact events can cause sudden volatility.\n` +
          `Your stop-loss has been temporarily tightened from ${wasStopLossPct}% to ${tightened}% during this event.\n\n` +
          `💡 Consider reducing position sizes until after the announcement.`
        );

        // Temporarily tighten stop-loss
        botConfig._preMacroStopLoss = wasStopLossPct;
        botConfig.stopLossPct       = tightened;

        // Restore after 2 hours
        setTimeout(() => {
          if (botConfig._preMacroStopLoss) {
            botConfig.stopLossPct = botConfig._preMacroStopLoss;
            delete botConfig._preMacroStopLoss;
            console.log(`[MACRO] Stop-loss restored to ${botConfig.stopLossPct}% after event`);
          }
        }, 2 * 60 * 60 * 1000);

        console.log(`[MACRO] Alert sent for: ${event.title}`);
      }
    }
  } catch(e) { console.warn('[MACRO] Check failed:', e.message); }
}

// API route to get upcoming macro events
app.get('/api/macro/events', requireAuth, async (req, res) => {
  try {
    const events = await fetchMacroCalendar();
    const now    = Date.now();
    const upcoming = events
      .filter(e => new Date(`${e.date} ${e.time}`).getTime() > now - 3600000)
      .sort((a,b) => new Date(`${a.date} ${a.time}`) - new Date(`${b.date} ${b.time}`))
      .slice(0, 10);
    res.json({ success:true, data: upcoming });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════
// FEATURE 2: CORRELATION INTELLIGENCE
// Calculates which coins recover fastest after BTC drops
// Uses existing OHLC data — zero extra API calls
// ══════════════════════════════════════════════════════════════
let correlationCache = { matrix:{}, fetchedAt:0 };

async function buildCorrelationMatrix() {
  // Rebuild every 6 hours
  if (Date.now() - correlationCache.fetchedAt < 6 * 60 * 60 * 1000) {
    return correlationCache.matrix;
  }
  try {
    console.log('[CORRELATION] Building correlation matrix...');
    const allReturns = {};

    // Fetch 1-day candles for all active pairs
    const pairs = getActivePairs(botConfig.currencyMode).slice(0, 8);
    for (const pair of pairs) {
      try {
        const ohlc  = await krakenPublicRequest('OHLC', { pair, interval: 1440 });
        const k     = Object.keys(ohlc).find(k => k !== 'last');
        const closes = ohlc[k].slice(-30).map(c => parseFloat(c[4]));
        // Calculate daily returns
        const returns = [];
        for (let i = 1; i < closes.length; i++) {
          returns.push((closes[i] - closes[i-1]) / closes[i-1]);
        }
        const sym = (PAIR_DISPLAY[pair]||pair).replace('/AUD','').replace('/USD','');
        allReturns[sym] = returns;
      } catch(e) {}
    }

    // Calculate correlation between each pair and BTC
    const btcReturns = allReturns['BTC'] || [];
    const matrix     = {};

    for (const [sym, returns] of Object.entries(allReturns)) {
      if (sym === 'BTC' || returns.length < 10) continue;

      const minLen = Math.min(btcReturns.length, returns.length);
      const btcSlice  = btcReturns.slice(-minLen);
      const coinSlice = returns.slice(-minLen);

      // Pearson correlation
      const n       = minLen;
      const sumX    = btcSlice.reduce((a,b) => a+b, 0);
      const sumY    = coinSlice.reduce((a,b) => a+b, 0);
      const sumXY   = btcSlice.reduce((s,x,i) => s + x*coinSlice[i], 0);
      const sumX2   = btcSlice.reduce((s,x) => s + x*x, 0);
      const sumY2   = coinSlice.reduce((s,y) => s + y*y, 0);
      const corr    = (n*sumXY - sumX*sumY) /
        Math.sqrt((n*sumX2 - sumX**2) * (n*sumY2 - sumY**2)) || 0;

      // Recovery speed: avg return in day AFTER BTC drops >1%
      const btcDropDays = btcSlice
        .map((r,i) => ({ btc:r, coin:coinSlice[i+1]||0 }))
        .filter(d => d.btc < -0.01);
      const avgRecovery = btcDropDays.length
        ? btcDropDays.reduce((s,d) => s+d.coin, 0) / btcDropDays.length
        : 0;

      matrix[sym] = {
        correlationWithBTC: parseFloat(corr.toFixed(3)),
        avgRecoveryAfterBTCDrop: parseFloat(avgRecovery.toFixed(4)),
        sampleDays: minLen,
        recoveryEvents: btcDropDays.length,
      };
    }

    correlationCache = { matrix, fetchedAt: Date.now() };
    console.log(`[CORRELATION] Matrix built for ${Object.keys(matrix).length} coins`);
    return matrix;
  } catch(e) {
    console.warn('[CORRELATION] Build failed:', e.message);
    return correlationCache.matrix || {};
  }
}

// Get best recovery coins after a BTC drop
async function getBestRecoveryCoins() {
  const matrix = await buildCorrelationMatrix();
  return Object.entries(matrix)
    .filter(([,d]) => d.recoveryEvents >= 3)
    .sort(([,a],[,b]) => b.avgRecoveryAfterBTCDrop - a.avgRecoveryAfterBTCDrop)
    .slice(0, 5)
    .map(([sym, d]) => ({
      sym,
      avgRecovery: (d.avgRecoveryAfterBTCDrop * 100).toFixed(2) + '%',
      correlation: d.correlationWithBTC,
      events:      d.recoveryEvents,
    }));
}

app.get('/api/correlation', requireAuth, async (req, res) => {
  try {
    const matrix    = await buildCorrelationMatrix();
    const bestCoins = await getBestRecoveryCoins();
    res.json({ success:true, data:{ matrix, bestRecoveryCoins:bestCoins } });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ══════════════════════════════════════════════════════════════
// FEATURE 3: GRID TRADING STRATEGY
// Places buy orders at intervals below price, sells above
// Profits from sideways volatile markets
// ══════════════════════════════════════════════════════════════
function calculateGridLevels(lower, upper, count) {
  const levels = [];
  const step   = (upper - lower) / count;
  for (let i = 0; i <= count; i++) {
    levels.push(parseFloat((lower + step * i).toFixed(8)));
  }
  return levels;
}

async function checkGridOrders() {
  for (const [pair, config] of Object.entries(gridConfigs)) {
    if (!config.enabled) continue;
    try {
      const ticker = await fetchSingleTicker(pair);
      if (!ticker) continue;
      const price = ticker.price;
      const dp    = PAIR_DISPLAY[pair] || pair;
      const levels = calculateGridLevels(config.lowerPrice, config.upperPrice, config.gridCount);

      // Find the grid level just below current price (buy zone)
      const buyLevel  = levels.filter(l => l < price).pop();
      // Find the grid level just above current price (sell zone)
      const sellLevel = levels.find(l => l > price);

      if (!buyLevel || !sellLevel) continue;

      const alreadyBoughtAtLevel = config.orders?.find(o =>
        o.type === 'buy' && Math.abs(o.price - buyLevel) / buyLevel < 0.001
      );

      if (!alreadyBoughtAtLevel && price <= buyLevel * 1.001) {
        // Place grid buy
        const volume = (config.amountPerGrid / price).toFixed(8);
        try {
          const order = await krakenPrivateRequest('AddOrder', {
            pair, type:'buy', ordertype:'limit',
            price: buyLevel.toString(), volume,
          });
          if (!config.orders) config.orders = [];
          config.orders.push({ type:'buy', price:buyLevel, volume, txid:order.txid?.[0], timestamp:Date.now() });
          saveData();
          await sendTelegram(
            `📊 <b>GRID BUY — ${dp}</b>\n` +
            `Level: ${fmtAUDServer(buyLevel, pair)}\n` +
            `Current: ${fmtAUDServer(price, pair)}\n` +
            `Volume: ${volume} ${(PAIR_DISPLAY[pair]||pair).replace('/AUD','').replace('/USD','')}\n` +
            `Next sell target: ${fmtAUDServer(sellLevel, pair)}`
          );
          console.log(`[GRID] BUY placed for ${dp} at ${buyLevel}`);
        } catch(e) { console.warn(`[GRID] Buy failed:`, e.message); }
      }
    } catch(e) { console.warn(`[GRID] Check failed for ${pair}:`, e.message); }
  }
}

app.get('/api/grid', requireAuth, (req, res) => {
  res.json({ success:true, data: gridConfigs });
});

app.post('/api/grid/:pair', requireAuth, (req, res) => {
  const pair = req.params.pair.toUpperCase();
  const { upperPrice, lowerPrice, gridCount, amountPerGrid, enabled } = req.body;
  gridConfigs[pair] = {
    enabled:       enabled !== false,
    upperPrice:    parseFloat(upperPrice),
    lowerPrice:    parseFloat(lowerPrice),
    gridCount:     parseInt(gridCount) || 5,
    amountPerGrid: parseFloat(amountPerGrid),
    orders:        [],
    createdAt:     new Date().toISOString(),
  };
  saveData();
  const levels = calculateGridLevels(lowerPrice, upperPrice, gridCount || 5);
  res.json({ success:true, data:{ ...gridConfigs[pair], levels } });
});

app.delete('/api/grid/:pair', requireAuth, (req, res) => {
  delete gridConfigs[req.params.pair.toUpperCase()];
  saveData();
  res.json({ success:true });
});

// ══════════════════════════════════════════════════════════════
// FEATURE 4: PORTFOLIO AUTO-REBALANCING
// When a position drifts 8%+ from target, auto-rebalances
// Extends existing target allocation system
// ══════════════════════════════════════════════════════════════
async function checkAndRebalance() {
  if (!rebalanceConfig.enabled) return;
  if (!Object.keys(targetAllocation).length) return;

  try {
    const bal   = await krakenPrivateRequest('Balance');
    let total   = 0;
    const vals  = {};

    // Calculate current values
    for (const [asset, qty] of Object.entries(bal)) {
      const q = parseFloat(qty);
      if (q <= 0) continue;
      if (['ZAUD','AUD','AUDX'].includes(asset)) {
        vals['cash'] = (vals['cash']||0) + q; total += q; continue;
      }
      const sym  = asset.replace(/^X/,'').replace(/^Z/,'').replace('XBT','BTC');
      const pair = sym === 'BTC' ? 'XBTAUD' : sym+'AUD';
      try {
        const tick = await fetchSingleTicker(pair);
        if (tick) { const v = q * tick.price; vals[sym] = v; total += v; }
      } catch(e) {}
    }

    if (total < 50) return;

    const trades = [];

    for (const [sym, targetPct] of Object.entries(targetAllocation)) {
      if (sym === 'cash') continue;
      const actualVal  = vals[sym] || 0;
      const actualPct  = (actualVal / total) * 100;
      const drift      = actualPct - targetPct;
      const targetVal  = (targetPct / 100) * total;
      const diffAUD    = Math.abs(actualVal - targetVal);

      if (Math.abs(drift) >= rebalanceConfig.driftThreshold && diffAUD >= rebalanceConfig.minTradeAUD) {
        trades.push({ sym, drift, actualPct, targetPct, diffAUD, action: drift > 0 ? 'SELL' : 'BUY' });
      }
    }

    if (!trades.length) return;

    // Execute rebalancing trades
    let report = `⚖️ <b>AUTO-REBALANCE EXECUTED</b>\n\nPortfolio: ${fmtAUDServer(total)}\n\n`;

    for (const trade of trades) {
      try {
        const pair   = trade.sym === 'BTC' ? 'XBTAUD' : trade.sym+'AUD';
        const ticker = await fetchSingleTicker(pair);
        if (!ticker) continue;
        const volume = (trade.diffAUD / ticker.price).toFixed(8);
        const order  = await krakenPrivateRequest('AddOrder', {
          pair, type: trade.action.toLowerCase(),
          ordertype:'market', volume,
        });
        recordTrade(pair, trade.sym, trade.action.toLowerCase(), volume, ticker.price, 'rebalance');
        report += `${trade.action === 'BUY' ? '🟢' : '🔴'} ${trade.action} ${trade.sym}\n`;
        report += `  ${trade.actualPct.toFixed(1)}% → ${trade.targetPct}% target\n`;
        report += `  Amount: ${fmtAUDServer(trade.diffAUD)}\n\n`;
        console.log(`[REBALANCE] ${trade.action} ${trade.sym} — drift ${trade.drift.toFixed(1)}%`);
      } catch(e) { report += `❌ ${trade.sym}: ${e.message}\n\n`; }
    }

    await sendTelegram(report);
    saveData();

  } catch(e) { console.warn('[REBALANCE] Failed:', e.message); }
}

app.get('/api/rebalance/config', requireAuth, (req, res) => {
  res.json({ success:true, data: rebalanceConfig });
});

app.post('/api/rebalance/config', requireAuth, (req, res) => {
  Object.assign(rebalanceConfig, req.body);
  saveData();
  res.json({ success:true, data: rebalanceConfig });
});

app.post('/api/rebalance/run', requireAuth, async (req, res) => {
  res.json({ success:true, message:'Rebalancing — check Telegram!' });
  checkAndRebalance();
});

// ══════════════════════════════════════════════════════════════
// FEATURE 5: PERFORMANCE BENCHMARKING
// Compares your bot returns against BTC and AUD cash
// Uses existing portfolioHistory + free CoinGecko prices
// ══════════════════════════════════════════════════════════════
let benchmarkCache = { data:null, fetchedAt:0 };

async function fetchBenchmarkData() {
  if (Date.now() - benchmarkCache.fetchedAt < 60 * 60 * 1000) return benchmarkCache.data;
  try {
    // CoinGecko free API — BTC price history (no key needed)
    const res  = await fetch('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=aud&days=90&interval=daily', {
      headers:{ 'User-Agent':'KRAKN-AI/4.0' }
    });
    const data = await res.json();
    benchmarkCache = { data: data.prices || [], fetchedAt: Date.now() };
    return benchmarkCache.data;
  } catch(e) {
    console.warn('[BENCHMARK] CoinGecko fetch failed:', e.message);
    return benchmarkCache.data || [];
  }
}

async function calculatePerformance(days = 30) {
  try {
    if (portfolioHistory.length < 2) return null;

    const now      = Date.now();
    const start    = now - days * 24 * 60 * 60 * 1000;
    const relevant = portfolioHistory.filter(p => p.timestamp >= start);
    if (relevant.length < 2) return null;

    const first = relevant[0];
    const last  = relevant[relevant.length - 1];
    const botReturn = ((last.valueAUD - first.valueAUD) / first.valueAUD) * 100;

    // BTC benchmark
    const btcPrices = await fetchBenchmarkData();
    let btcReturn   = 0;
    if (btcPrices.length >= 2) {
      const btcStart = btcPrices.find(p => p[0] >= start)?.[1] || btcPrices[0][1];
      const btcEnd   = btcPrices[btcPrices.length - 1][1];
      btcReturn      = ((btcEnd - btcStart) / btcStart) * 100;
    }

    // Win rate from trade log
    const periodTrades  = tradeLog.filter(t => new Date(t.timestamp).getTime() >= start);
    const sells         = periodTrades.filter(t => t.type === 'sell');
    const profitableSells = sells.filter(t => (t.realisedPnl || 0) > 0);
    const winRate       = sells.length ? (profitableSells.length / sells.length) * 100 : 0;

    // Best and worst trades
    const sortedSells = sells.sort((a,b) => (b.realisedPnl||0) - (a.realisedPnl||0));
    const bestTrade   = sortedSells[0];
    const worstTrade  = sortedSells[sortedSells.length - 1];

    return {
      period:        days,
      startValue:    first.valueAUD,
      endValue:      last.valueAUD,
      botReturn:     parseFloat(botReturn.toFixed(2)),
      btcReturn:     parseFloat(btcReturn.toFixed(2)),
      cashReturn:    0, // holding AUD = 0% return (inflation ignored)
      alpha:         parseFloat((botReturn - btcReturn).toFixed(2)),
      totalTrades:   periodTrades.length,
      winRate:       parseFloat(winRate.toFixed(1)),
      bestTrade:     bestTrade ? { sym:bestTrade.sym, pnl:bestTrade.realisedPnl } : null,
      worstTrade:    worstTrade ? { sym:worstTrade.sym, pnl:worstTrade.realisedPnl } : null,
      dataPoints:    relevant.length,
      outperforming: botReturn > btcReturn,
    };
  } catch(e) {
    console.warn('[BENCHMARK] Calc failed:', e.message);
    return null;
  }
}

app.get('/api/performance', requireAuth, async (req, res) => {
  try {
    const days    = parseInt(req.query.days) || 30;
    const perf    = await calculatePerformance(days);
    res.json({ success:true, data: perf });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── Smart Money Status in /health ─────────────────────────────
app.get('/api/chart/snapshot/:pair', requireAuth, async (req, res) => {
  try {
    const pair     = req.params.pair.toUpperCase();
    const interval = parseInt(req.query.interval) || 60;
    const ohlc     = await krakenPublicRequest('OHLC', { pair, interval });
    const k        = Object.keys(ohlc).find(k => k !== 'last');
    const candles  = ohlc[k].slice(-60);
    const buf      = renderChartToBuffer(candles, 600, 300);
    if (!buf) return res.status(503).json({ error: 'Canvas not available — run npm install' });
    res.setHeader('Content-Type', 'image/png');
    res.send(buf);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/chart/telegram/:pair', requireAuth, async (req, res) => {
  try {
    const pair     = req.params.pair.toUpperCase();
    const dp       = PAIR_DISPLAY[pair] || pair;
    const interval = parseInt(req.query.interval) || 60;
    const ohlc     = await krakenPublicRequest('OHLC', { pair, interval });
    const k        = Object.keys(ohlc).find(k => k !== 'last');
    const candles  = ohlc[k].slice(-60);
    const buf      = renderChartToBuffer(candles, 600, 300);
    if (!buf) return res.status(503).json({ error: 'Canvas not available' });
    const signal   = await computeSignalForPair(pair);
    const vision   = signal.vision;
    const ticker   = await fetchSingleTicker(pair);

    // Send photo to Telegram using multipart form
    const boundary = '----FormBoundary' + Date.now();
    const chunks   = [];
    const field = (name, value) => {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    };
    field('chat_id', TELEGRAM_CHAT_ID);
    field('parse_mode', 'HTML');
    field('caption',
      `📊 <b>${dp} — ${fmtAUDServer(ticker?.price || 0)}</b>\n\n` +
      `${signal.action === 'BUY' ? '🟢' : signal.action === 'SELL' ? '🔴' : '🟡'} <b>${signal.action}</b> ${signal.confidence}% | Score: ${signal.weightedScore} | RSI: ${signal.rsi}\n` +
      `${vision ? `\n👁 <b>Visual Analysis</b>\n` +
        `Pattern: ${vision.visualPattern}\n` +
        `${vision.keyObservation}\n` +
        `Trend: ${vision.trendDirection} (${vision.trendStrength})\n` +
        `Support: ${fmtAUDServer(vision.supportLevel)} | Resistance: ${fmtAUDServer(vision.resistanceLevel)}` : ''}`
    );
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${dp.replace('/','_')}.png"\r\nContent-Type: image/png\r\n\r\n`));
    chunks.push(buf);
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(chunks);

    await new Promise((resolve, reject) => {
      const req2 = require('https').request({
        hostname: 'api.telegram.org',
        path:     `/bot${TELEGRAM_TOKEN}/sendPhoto`,
        method:   'POST',
        headers:  { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
      }, (res2) => { let d=''; res2.on('data',c=>d+=c); res2.on('end',()=>resolve(JSON.parse(d))); });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });

    console.log(`[CHART TELEGRAM] Sent ${dp} chart`);
    res.json({ success: true, message: `${dp} chart sent to Telegram`, vision });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/signal/full', requireAuth, async (req, res) => {
  try {
    const { pair } = req.body;
    if (!pair) return res.status(400).json({ error: 'pair required' });
    const signal = await computeSignalForPair(pair);
    const ticker = await fetchSingleTicker(pair);
    res.json({ success: true, data: { ...signal, price: ticker?.price, pair } });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════
// AUTO-SELL BOT ROUTES
// ═══════════════════════════════════════════════════════════════
app.get('/api/bot/config',  requireAuth, (req, res) => res.json({ success:true, data:{ ...botConfig, state:botState } }));
app.post('/api/bot/config', requireAuth, (req, res) => {
  botConfig = { ...botConfig, ...req.body };
  saveData(); // persist immediately
  res.json({ success:true, data:botConfig });
});
app.get('/api/bot/status',  requireAuth, (req, res) => res.json({ success:true, data:botState }));

app.post('/api/bot/start', requireAuth, requireKeys, (req, res) => {
  if (botState.running) return res.json({ success:true, message:'Already running' });
  botState.running = true;
  saveData(); // persist — so bot auto-restarts after Railway restart
  console.log('[AUTO-SELL BOT] Started');
  sendTelegram(
    '🤖 <b>KRAKN·AI Auto-Sell Bot Started!</b>\n\n' +
    `Watching ALL holdings every ${botConfig.checkInterval} seconds.\n` +
    `Holdings under <b>${fmtAUDServer(botConfig.minHoldingValueAUD)}</b> are ignored.\n` +
    `Holdings over <b>${fmtAUDServer(botConfig.minHoldingValueAUD)}</b> will be fully sold when RSI signals overbought.\n` +
    `Min confidence: <b>${botConfig.confidenceMin}%</b>\n\n` +
    '⚠️ You will receive a Telegram alert before and after every sell.'
  );
  startAutoSellLoop();
  res.json({ success:true, message:'Auto-sell bot started' });
});

app.post('/api/bot/stop', requireAuth, (req, res) => {
  botState.running = false;
  saveData(); // persist bot OFF state
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

      const dp              = PAIR_DISPLAY[holding.pair] || holding.pair;
      const holdingValueAUD = holding.qty * ticker.price;

      // ── Skip small holdings ───────────────────────────────
      if (holdingValueAUD < botConfig.minHoldingValueAUD) {
        console.log(`[AUTO-SELL BOT] ${dp} ignored — ${fmtAUDServer(holdingValueAUD)} below minimum`);
        continue;
      }

      // ── Minimum Hold Time Check ───────────────────────────
      // Never sell within minHoldMinutes of buying — prevents churn on noise
      const lastBought = lastBuyTimes[holding.sym];
      if (lastBought) {
        const heldMinutes = (Date.now() - lastBought) / 1000 / 60;
        if (heldMinutes < botConfig.minHoldMinutes) {
          console.log(`[AUTO-SELL BOT] ${dp} — hold time enforced (${heldMinutes.toFixed(0)}/${botConfig.minHoldMinutes} min)`);
          continue;
        }
      }

      // ── Stop-Loss Check ───────────────────────────────────
      const pnl = getUnrealisedPnl(holding.sym, ticker.price, holding.qty);
      if (botConfig.stopLossEnabled && pnl.avgBuyPrice > 0) {

        // Trailing stop — track highest price since buy
        if (botConfig.trailingStop) {
          if (!stopLossPeaks[holding.sym] || ticker.price > stopLossPeaks[holding.sym]) {
            stopLossPeaks[holding.sym] = ticker.price;
          }
          const peakPrice  = stopLossPeaks[holding.sym];
          const dropFromPeak = ((ticker.price - peakPrice) / peakPrice) * 100;
          if (dropFromPeak <= -botConfig.stopLossPct) {
            console.log(`[TRAILING STOP] ${dp} triggered — dropped ${dropFromPeak.toFixed(1)}% from peak ${fmtAUDServer(peakPrice)}`);
            await sendTelegram(
              `🛑 <b>TRAILING STOP-LOSS TRIGGERED!</b>\n\n` +
              `<b>${dp}</b>\n` +
              `Current: ${fmtAUDServer(ticker.price)}\n` +
              `Peak since buy: ${fmtAUDServer(peakPrice)}\n` +
              `Drop from peak: <b>${dropFromPeak.toFixed(1)}%</b> (limit: -${botConfig.stopLossPct}%)\n` +
              `P&L: ${pnl.unrealisedPnl >= 0 ? '🟢 +' : '🔴 '}${fmtAUDServer(pnl.unrealisedPnl)}\n\n` +
              `⏳ Selling to lock in ${pnl.unrealisedPnl >= 0 ? 'profit' : 'and cut loss'}...`
            );
            delete stopLossPeaks[holding.sym]; // reset peak
            await executeSell(holding, ticker, 'trailing-stop', `Trailing stop: -${dropFromPeak.toFixed(1)}% from peak`, dp);
            continue;
          }
        } else {
          // Standard stop-loss — drop from avg buy
          const dropPct = ((ticker.price - pnl.avgBuyPrice) / pnl.avgBuyPrice) * 100;
          if (dropPct <= -botConfig.stopLossPct) {
            console.log(`[STOP-LOSS] ${dp} triggered — dropped ${dropPct.toFixed(1)}% from avg buy ${fmtAUDServer(pnl.avgBuyPrice)}`);
            const sydneyTime = new Date().toLocaleString('en-AU', { timeZone:'Australia/Sydney', dateStyle:'short', timeStyle:'short' });
            await sendTelegram(
              `🛑 <b>STOP-LOSS TRIGGERED!</b>\n\n` +
              `<b>${dp}</b>\n` +
              `Current price: ${fmtAUDServer(ticker.price)}\n` +
              `Avg buy price: ${fmtAUDServer(pnl.avgBuyPrice)}\n` +
              `Drop: <b>${dropPct.toFixed(1)}%</b> (limit: -${botConfig.stopLossPct}%)\n` +
              `Unrealised loss: ${fmtAUDServer(pnl.unrealisedPnl)}\n\n` +
              `⏳ Selling full holding to protect capital...`
            );
            await executeSell(holding, ticker, 'stop-loss', `Stop-loss at ${dropPct.toFixed(1)}% drop`, dp);
            continue;
          }
        }
      }

      // ── Multi-Indicator Signal ────────────────────────────
      const signal = await computeSignalForPair(holding.pair);
      botState.lastSignals[holding.pair] = {
        ...signal, price: ticker.price,
        pnl: pnl.avgBuyPrice > 0 ? { pct: pnl.pnlPct.toFixed(1), aud: pnl.unrealisedPnl.toFixed(2) } : null,
        checkedAt: new Date().toISOString()
      };

      console.log(`[AUTO-SELL BOT] ${dp} Score:${signal.weightedScore} ${signal.action} ${signal.confidence}%`);

      if (signal.action !== 'SELL') continue;
      if (signal.confidence < botConfig.confidenceMin) {
        console.log(`[AUTO-SELL BOT] ${dp} skipped — confidence ${signal.confidence}% < ${botConfig.confidenceMin}%`);
        continue;
      }

      // ── Signal sell — full holding ────────────────────────
      const signalSummary = signal.signals?.slice(0,3).join(', ') || `Score ${signal.weightedScore}`;
      await executeSell(holding, ticker, 'bot-sell', `Multi-indicator sell signal: ${signalSummary}`, dp, signal);

      await new Promise(r => setTimeout(r, 2000));

    } catch(e) {
      console.error(`[AUTO-SELL BOT] Error checking ${holding.sym}:`, e.message);
    }
  }
}

// ─── Execute Sell (reusable) ───────────────────────────────────
async function executeSell(holding, ticker, source, reason, dp, signal = null) {
  const minVol  = MIN_VOLUMES[holding.sym] || 0.0001;
  const sellQty = holding.qty;

  if (sellQty < minVol) {
    console.log(`[SELL] ${dp} skipped — ${sellQty.toFixed(8)} below Kraken minimum ${minVol}`);
    return;
  }

  const sellVolume   = sellQty.toFixed(8);
  const sellValueAUD = (sellQty * ticker.price).toFixed(2);
  const pnl          = getUnrealisedPnl(holding.sym, ticker.price, holding.qty);
  const pnlStr       = pnl.avgBuyPrice > 0
    ? `\nP&L on this trade: ${pnl.unrealisedPnl >= 0 ? '🟢 +' : '🔴 '}${fmtAUDServer(pnl.unrealisedPnl)} (${pnl.pnlPct.toFixed(1)}%)`
    : '';

  // Pre-sell warning
  await sendTelegram(
    `⚠️ <b>${source === 'stop-loss' ? 'STOP-LOSS' : 'AUTO-SELL'} TRIGGERED!</b>\n\n` +
    `<b>${dp}</b>\n` +
    (signal ? `Confidence: ${signal.confidence}% | Score: ${signal.weightedScore}\n` : '') +
    `Current price: ${fmtAUDServer(ticker.price)}\n` +
    `Selling: ${sellVolume} ${holding.sym} (≈ ${fmtAUDServer(parseFloat(sellValueAUD))})\n` +
    `Reason: ${reason}${pnlStr}\n\n` +
    `⏳ Placing order now...`
  );

  try {
    const order = await krakenPrivateRequest('AddOrder', {
      pair: holding.pair, type: 'sell', ordertype: 'market', volume: sellVolume,
    });

    // Record in P&L tracker
    recordTrade(holding.pair, holding.sym, 'sell', sellVolume, ticker.price, source);

    botState.lastSell = {
      pair: holding.pair, sym: holding.sym,
      volume: sellVolume, price: ticker.price,
      valueAUD: sellValueAUD, txid: order.txid,
      pnl: pnlStr,
      timestamp: new Date().toISOString()
    };
    botState.sellsCount++;

    const sydneyTime = new Date().toLocaleString('en-AU', { timeZone:'Australia/Sydney', dateStyle:'short', timeStyle:'short' });
    const realisedPnl = pnlByAsset[holding.sym]?.realisedPnl || 0;

    await sendTelegram(
      `🔴 <b>SELL COMPLETED!</b>\n\n` +
      `<b>${dp}</b>\n` +
      `Sold: ${sellVolume} ${holding.sym}\n` +
      `Price: ${fmtAUDServer(ticker.price)}\n` +
      `Value: ≈ ${fmtAUDServer(parseFloat(sellValueAUD))}\n` +
      `TXID: ${order.txid?.join(', ')}\n` +
      `${pnlStr}\n` +
      `Total realised P&L (${holding.sym}): ${realisedPnl >= 0 ? '🟢 +' : '🔴 '}${fmtAUDServer(realisedPnl)}\n\n` +
      `⏰ ${sydneyTime} AEST`
    );

    console.log(`[SELL] ✅ ${sellVolume} ${holding.sym} @ ${fmtAUDServer(ticker.price)} — P&L: ${fmtAUDServer(pnl.unrealisedPnl)}`);

  } catch(orderErr) {
    console.error(`[SELL] Order failed for ${holding.sym}:`, orderErr.message);
    await sendTelegram(
      `❌ <b>SELL FAILED!</b>\n\n` +
      `<b>${dp}</b> — ${orderErr.message}\n\n` +
      `Please sell manually in the app if needed.`
    );
  }
}

// ══════════════════════════════════════════════════════════════
// DCA BOT (Dollar Cost Averaging)
// ══════════════════════════════════════════════════════════════

app.get('/api/dca/config',  requireAuth, (req, res) => res.json({ success:true, data:dcaConfig }));
app.post('/api/dca/config', requireAuth, (req, res) => {
  Object.assign(dcaConfig, req.body);
  saveData();
  scheduleDCA();
  res.json({ success:true, data:dcaConfig });
});
app.post('/api/dca/run', requireAuth, requireKeys, async (req, res) => {
  res.json({ success:true, message:'Running DCA now — check Telegram!' });
  runDCA();
});

function scheduleDCA() {
  if (dcaTimer) clearInterval(dcaTimer);
  if (!dcaConfig.enabled) { console.log('[DCA] Disabled'); return; }
  // Check every hour if it's time to run
  dcaTimer = setInterval(async () => {
    try { checkDCASchedule(); }
    catch(e) { console.error('[DCA] Interval error:', e.message); }
  }, 60 * 60 * 1000);
  console.log(`[DCA] Scheduled: ${dcaConfig.frequency} ${fmtAUDServer(dcaConfig.amountAUD)} into ${dcaConfig.pairs.join(',')}`);
}

function checkDCASchedule() {
  if (!dcaConfig.enabled) return;
  const now     = new Date();
  const sydney  = new Date(now.toLocaleString('en-US', { timeZone:'Australia/Sydney' }));
  const hour    = sydney.getHours();
  const day     = sydney.getDay();   // 0=Sun
  const date    = sydney.getDate();

  // Only run at configured hour
  if (hour !== dcaConfig.hour) return;

  // Check frequency
  let shouldRun = false;
  if (dcaConfig.frequency === 'daily') shouldRun = true;
  if (dcaConfig.frequency === 'weekly' && day === dcaConfig.dayOfWeek) shouldRun = true;
  if (dcaConfig.frequency === 'monthly' && date === 1) shouldRun = true;

  if (!shouldRun) return;

  // Check we haven't already run today
  if (dcaConfig.lastRun) {
    const lastRun = new Date(dcaConfig.lastRun);
    const hrs     = (now - lastRun) / 1000 / 3600;
    if (hrs < 20) { console.log('[DCA] Already ran recently, skipping'); return; }
  }

  runDCA();
}

async function runDCA() {
  console.log('[DCA] Running...');
  dcaConfig.lastRun = new Date().toISOString();
  saveData();

  try {
    // Check AUD balance
    const bal    = await krakenPrivateRequest('Balance');
    const audBal = parseFloat(bal['ZAUD'] || bal['AUD'] || 0);

    if (audBal < dcaConfig.amountAUD) {
      await sendTelegram(
        `ℹ️ <b>DCA Bot — Insufficient Balance</b>\n\n` +
        `Need: ${fmtAUDServer(dcaConfig.amountAUD)} AUD\n` +
        `Available: ${fmtAUDServer(audBal)} AUD\n\n` +
        `Top up your Kraken account to resume DCA.`
      );
      return;
    }

    const amountPerCoin = dcaConfig.amountAUD / dcaConfig.pairs.length;
    const results       = [];

    for (const pair of dcaConfig.pairs) {
      try {
        const ticker = await fetchSingleTicker(pair);
        if (!ticker) { console.warn(`[DCA] No ticker for ${pair}`); continue; }

        const volume = (amountPerCoin / ticker.price).toFixed(8);
        const dp     = PAIR_DISPLAY[pair] || pair;
        const sym    = dp.replace('/AUD','');
        const minVol = MIN_VOLUMES[sym] || 0.0001;

        if (parseFloat(volume) < minVol) {
          console.warn(`[DCA] ${dp} volume ${volume} below minimum ${minVol}`);
          continue;
        }

        const order = await krakenPrivateRequest('AddOrder', {
          pair, type: 'buy', ordertype: 'market', volume,
        });

        recordTrade(pair, sym, 'buy', volume, ticker.price, 'dca');
        lastBuyTimes[sym] = Date.now(); // enforce hold time after DCA buy
        dcaConfig.totalSpent += amountPerCoin;
        results.push({ dp, volume, price: ticker.price, value: amountPerCoin, txid: order.txid });
        console.log(`[DCA] ✅ Bought ${volume} ${sym} @ ${fmtAUDServer(ticker.price)}`);

        await new Promise(r => setTimeout(r, 1500));
      } catch(e) {
        console.error(`[DCA] Error buying ${pair}:`, e.message);
        results.push({ dp: pair, error: e.message });
      }
    }

    const sydneyTime = new Date().toLocaleString('en-AU', { timeZone:'Australia/Sydney', dateStyle:'short', timeStyle:'short' });
    const successList = results.filter(r => !r.error);
    const failList    = results.filter(r => r.error);

    await sendTelegram(
      `📅 <b>DCA Bot Executed!</b>\n\n` +
      `${successList.map(r => `🟢 Bought ${r.volume} <b>${r.dp.replace('/AUD','')}</b>\n   ${fmtAUDServer(r.value)} @ ${fmtAUDServer(r.price)}`).join('\n')}\n` +
      `${failList.length ? `\n❌ Failed: ${failList.map(r=>r.dp).join(', ')}` : ''}\n\n` +
      `Total spent to date: ${fmtAUDServer(dcaConfig.totalSpent)}\n` +
      `Next run: ${dcaConfig.frequency}\n` +
      `⏰ ${sydneyTime} AEST`
    );

    saveData();
  } catch(e) {
    console.error('[DCA ERROR]', e.message);
    await sendTelegram(`❌ <b>DCA Bot Error</b>\n\n${e.message}`);
  }
}

// ══════════════════════════════════════════════════════════════
// v4.0: CHART VISION ENGINE
// Renders candlestick charts server-side and sends to Claude Vision
// for pattern recognition beyond what pure numbers can detect
// ══════════════════════════════════════════════════════════════

// Chart vision cache — avoid re-analysing same candles
const visionCache = {}; // { cacheKey: { analysis, timestamp } }

function renderChartToBuffer(candles, width = 600, height = 300) {
  if (!createCanvas) return null;
  try {
    const canvas = createCanvas(width, height);
    const ctx    = canvas.getContext('2d');

    // Background
    ctx.fillStyle = '#0A0A0F';
    ctx.fillRect(0, 0, width, height);

    // Grid
    ctx.strokeStyle = 'rgba(0,212,255,0.08)';
    ctx.lineWidth   = 0.5;
    for (let i = 0; i <= 5; i++) {
      const y = (height / 5) * i;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
    for (let i = 0; i <= 8; i++) {
      const x = (width / 8) * i;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }

    // Price range
    const highs  = candles.map(c => parseFloat(c[2]));
    const lows   = candles.map(c => parseFloat(c[3]));
    const mn     = Math.min(...lows)  * 0.998;
    const mx     = Math.max(...highs) * 1.002;
    const range  = mx - mn || 1;

    const padT = 20, padB = 40, padL = 10, padR = 10;
    const cW   = width  - padL - padR;
    const cH   = height - padT - padB;
    const toY  = v => padT + cH - ((v - mn) / range) * cH;
    const candW = cW / candles.length;
    const bodyW = Math.max(candW * 0.65, 2);

    // Volume bars
    const volumes = candles.map(c => parseFloat(c[6]));
    const maxVol  = Math.max(...volumes) || 1;
    const volH    = cH * 0.12;

    candles.forEach((c, i) => {
      const vol  = parseFloat(c[6]);
      const bull = parseFloat(c[4]) >= parseFloat(c[1]);
      const x    = padL + i * candW;
      const bh   = (vol / maxVol) * volH;
      ctx.fillStyle = bull ? 'rgba(0,200,150,0.25)' : 'rgba(255,68,102,0.25)';
      ctx.fillRect(x, height - padB - bh, Math.max(candW - 1, 1), bh);
    });

    // Candlesticks
    candles.forEach((c, i) => {
      const open  = parseFloat(c[1]);
      const high  = parseFloat(c[2]);
      const low   = parseFloat(c[3]);
      const close = parseFloat(c[4]);
      const bull  = close >= open;
      const x     = padL + i * candW + candW / 2;
      const col   = bull ? '#00C896' : '#FF4466';

      // Wick
      ctx.strokeStyle = col;
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(x, toY(high));
      ctx.lineTo(x, toY(low));
      ctx.stroke();

      // Body
      const top = toY(Math.max(open, close));
      const bot = toY(Math.min(open, close));
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(x - bodyW/2, top, bodyW, Math.max(bot - top, 1));
      ctx.globalAlpha = 1;
    });

    // 20-period moving average line
    const closes = candles.map(c => parseFloat(c[4]));
    const ma20   = [];
    for (let i = 0; i < closes.length; i++) {
      if (i < 19) { ma20.push(null); continue; }
      const avg = closes.slice(i - 19, i + 1).reduce((a,b) => a+b,0) / 20;
      ma20.push(avg);
    }
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,184,0,0.7)';
    ctx.lineWidth   = 1.5;
    let started = false;
    ma20.forEach((v, i) => {
      if (v === null) return;
      const x = padL + i * candW + candW/2;
      if (!started) { ctx.moveTo(x, toY(v)); started = true; }
      else ctx.lineTo(x, toY(v));
    });
    ctx.stroke();

    // Bollinger Bands
    const bb20 = [];
    for (let i = 0; i < closes.length; i++) {
      if (i < 19) { bb20.push(null); continue; }
      const slice  = closes.slice(i - 19, i + 1);
      const mean   = slice.reduce((a,b)=>a+b,0) / 20;
      const stdDev = Math.sqrt(slice.reduce((s,v)=>s+Math.pow(v-mean,2),0)/20);
      bb20.push({ upper: mean + 2*stdDev, lower: mean - 2*stdDev });
    }
    // Upper band
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(0,212,255,0.35)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([3, 3]);
    started = false;
    bb20.forEach((v, i) => {
      if (!v) return;
      const x = padL + i * candW + candW/2;
      if (!started) { ctx.moveTo(x, toY(v.upper)); started = true; }
      else ctx.lineTo(x, toY(v.upper));
    });
    ctx.stroke();
    // Lower band
    ctx.beginPath();
    started = false;
    bb20.forEach((v, i) => {
      if (!v) return;
      const x = padL + i * candW + candW/2;
      if (!started) { ctx.moveTo(x, toY(v.lower)); started = true; }
      else ctx.lineTo(x, toY(v.lower));
    });
    ctx.stroke();
    ctx.setLineDash([]);

    // Price labels on right
    ctx.fillStyle  = 'rgba(148,163,184,0.8)';
    ctx.font       = 'bold 11px sans-serif';
    ctx.textAlign  = 'right';
    const lastClose = closes[closes.length - 1];
    ctx.fillStyle   = lastClose >= closes[closes.length-2] ? '#00C896' : '#FF4466';
    ctx.fillText(lastClose.toFixed(lastClose > 1000 ? 0 : 4), width - 4, toY(lastClose) + 4);

    // Time labels bottom
    ctx.fillStyle = 'rgba(148,163,184,0.5)';
    ctx.font      = '9px sans-serif';
    ctx.textAlign = 'center';
    [0, Math.floor(candles.length/4), Math.floor(candles.length/2),
     Math.floor(candles.length*3/4), candles.length-1].forEach(i => {
      if (!candles[i]) return;
      const d = new Date(candles[i][0] * 1000);
      const x = padL + i * candW + candW/2;
      ctx.fillText(`${d.getDate()}/${d.getMonth()+1}`, x, height - padB + 12);
    });

    return canvas.toBuffer('image/png');
  } catch(e) {
    console.error('[CHART RENDER]', e.message);
    return null;
  }
}

async function analyseChartWithVision(pair, candles, indicators) {
  if (!createCanvas) return null;
  try {
    // Check cache — use last candle timestamp as key
    const lastCandle = candles[candles.length - 1];
    const cacheKey   = `${pair}_${lastCandle[0]}`;
    const cached     = visionCache[cacheKey];
    if (cached && (Date.now() - cached.timestamp) < 15 * 60 * 1000) {
      return cached.analysis;
    }

    const imgBuffer = renderChartToBuffer(candles, 600, 300);
    if (!imgBuffer) return null;
    const base64Img = imgBuffer.toString('base64');

    const dp = PAIR_DISPLAY[pair] || pair;
    const tfLabel = indicators.timeframe || '1-Hour';
    const prompt = `You are an expert technical analyst reviewing a ${dp} ${tfLabel} candlestick chart.

The chart shows:
- Candlestick OHLC data (green = bullish, red = bearish)  
- Yellow line = 20-period moving average
- Blue dashed lines = Bollinger Bands (2 std dev)
- Volume bars at bottom

Timeframe context: ${tfLabel} chart
${indicators.timeframe === '15-Min' ? '(Short-term — look for immediate momentum and breakouts)' : ''}
${indicators.timeframe === '1-Hour' ? '(Intraday — balance between noise and signal)' : ''}
${indicators.timeframe === '4-Hour' ? '(Swing trading — medium-term trend and structure)' : ''}
${indicators.timeframe === 'Daily'  ? '(Position trading — major trends and key levels)' : ''}
${indicators.timeframe === 'Weekly' ? '(Macro view — primary trend direction only)' : ''}

Current calculated indicators:
- RSI: ${indicators.rsi}
- MACD trend: ${indicators.macdTrend}
- BB position: ${indicators.bbPosition}
- Weighted score: ${indicators.weightedScore}

Analyse the VISUAL chart for:
1. Chart patterns (head & shoulders, triangles, wedges, flags, double tops/bottoms)
2. Support and resistance levels
3. Trend direction and strength
4. Volume confirmation of moves
5. Any divergences or warning signs

Return ONLY this JSON (no markdown, no explanation):
{
  "visualPattern": "name of main pattern or 'No clear pattern'",
  "patternSignal": "BULLISH|BEARISH|NEUTRAL",
  "patternStrength": 7,
  "supportLevel": 90000,
  "resistanceLevel": 95000,
  "trendDirection": "UPTREND|DOWNTREND|SIDEWAYS",
  "trendStrength": "STRONG|MODERATE|WEAK",
  "volumeConfirmation": true,
  "visualScore": 6,
  "keyObservation": "one sentence describing the most important visual signal",
  "visionAction": "BUY|SELL|HOLD",
  "visionConfidence": 72
}

patternStrength and visualScore are 1-10. visionConfidence is 0-99.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: base64Img
              }
            },
            { type: 'text', text: prompt }
          ]
        }]
      })
    });

    const data  = await response.json();
    const text  = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    const clean = text.replace(/```json|```/g, '').trim();
    const analysis = JSON.parse(clean);

    // Cache it
    visionCache[cacheKey] = { analysis, timestamp: Date.now() };
    console.log(`[VISION] ${dp}: ${analysis.visualPattern} → ${analysis.visionAction} ${analysis.visionConfidence}%`);
    return analysis;

  } catch(e) {
    console.warn('[VISION] Analysis failed:', e.message);
    return null;
  }
}
// Runs current multi-indicator strategy over historical OHLC data
// ══════════════════════════════════════════════════════════════
app.post('/api/backtest', requireAuth, async (req, res) => {
  try {
    const { pair = 'XBTAUD', days = 30 } = req.body;
    const interval  = 60; // 1hr candles for backtesting
    const dp        = PAIR_DISPLAY[pair] || pair;

    // Fetch enough candles — 30 days * 24 hrs = 720 candles
    const ohlc    = await krakenPublicRequest('OHLC', { pair, interval });
    const k       = Object.keys(ohlc).find(k => k !== 'last');
    const allCandles = ohlc[k];

    // Limit to requested days
    const candlesNeeded = days * 24;
    const candles       = allCandles.slice(-Math.min(candlesNeeded + 50, allCandles.length));

    const trades    = [];
    let inPosition  = false;
    let buyPrice    = 0;
    let buyTime     = null;
    let wins = 0, losses = 0, totalPnlPct = 0;

    // Simulate strategy candle by candle (walk-forward)
    for (let i = 50; i < candles.length - 1; i++) {
      const window = candles.slice(0, i + 1);
      const closes  = window.map(c => parseFloat(c[4]));
      const volumes = window.map(c => parseFloat(c[6]));
      const price   = closes[closes.length - 1];
      const time    = new Date(candles[i][0] * 1000).toISOString();

      const rsi     = calcRSI(closes);
      const macd    = calcMACD(closes);
      const bb      = calcBollingerBands(closes);
      const volSig  = calcVolumeSignal(volumes, closes);
      const patterns = detectCandlePatterns(window.slice(-5));

      // Score (simplified single timeframe for backtest speed)
      let score = 0;
      if (rsi < 30) score += 2; else if (rsi < 45) score += 1;
      else if (rsi > 70) score -= 2; else if (rsi > 55) score -= 1;
      if (macd.trend === 'BULLISH') score += 1; else if (macd.trend === 'BEARISH') score -= 1;
      if (bb.position === 'OVERSOLD') score += 2; else if (bb.position === 'OVERBOUGHT') score -= 2;
      if (volSig === 'STRONG_BUY') score += 2; else if (volSig === 'STRONG_SELL') score -= 2;
      score += scorePatterns(patterns).score * 0.5;

      if (!inPosition && score >= 4) {
        // BUY signal
        inPosition = true;
        buyPrice   = price;
        buyTime    = time;
        trades.push({ type:'BUY', price, time, score: Math.round(score), rsi });
      } else if (inPosition && (score <= -4 || rsi > 70)) {
        // SELL signal
        inPosition = false;
        const pnlPct = ((price - buyPrice) / buyPrice) * 100;
        totalPnlPct += pnlPct;
        if (pnlPct > 0) wins++; else losses++;
        trades.push({ type:'SELL', price, time, score: Math.round(score), rsi,
          pnlPct: parseFloat(pnlPct.toFixed(2)),
          buyPrice: parseFloat(buyPrice.toFixed(2)) });
        buyPrice = 0;
      }
    }

    const totalTrades = wins + losses;
    const winRate     = totalTrades > 0 ? ((wins / totalTrades) * 100) : 0;
    const avgPnl      = totalTrades > 0 ? (totalPnlPct / totalTrades) : 0;

    // Current price for unrealised if still in position
    const lastCandle  = candles[candles.length - 1];
    const lastPrice   = parseFloat(lastCandle[4]);
    const unrealised  = inPosition ? ((lastPrice - buyPrice) / buyPrice) * 100 : 0;
    const totalReturn = totalPnlPct + unrealised;

    res.json({ success: true, data: {
      pair: dp, days, interval,
      totalTrades, wins, losses,
      winRate:     parseFloat(winRate.toFixed(1)),
      avgPnlPct:   parseFloat(avgPnl.toFixed(2)),
      totalReturn: parseFloat(totalReturn.toFixed(2)),
      inPosition, buyPrice: inPosition ? buyPrice : null,
      trades: trades.slice(-50), // last 50 trades
      candleCount: candles.length,
    }});
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════
// v4.0: TARGET ALLOCATION
// ══════════════════════════════════════════════════════════════
app.get('/api/allocation', requireAuth, (req, res) => {
  res.json({ success: true, data: targetAllocation });
});

app.post('/api/allocation', requireAuth, (req, res) => {
  Object.assign(targetAllocation, req.body);
  saveData();
  res.json({ success: true, data: targetAllocation });
});

app.get('/api/allocation/check', requireAuth, requireKeys, async (req, res) => {
  try {
    if (!Object.keys(targetAllocation).length) {
      return res.json({ success: true, data: { drifts: [], message: 'No target allocation set' } });
    }
    const bal  = await krakenPrivateRequest('Balance');
    let total  = 0;
    const vals = {};

    for (const [asset, qty] of Object.entries(bal)) {
      const q = parseFloat(qty);
      if (q <= 0) continue;
      if (['ZAUD','AUD','AUDX'].includes(asset)) { vals['cash'] = (vals['cash']||0) + q; total += q; continue; }
      const sym  = asset.replace(/^X/,'').replace(/^Z/,'').replace('XBT','BTC');
      const pair = sym === 'BTC' ? 'XBTAUD' : sym+'AUD';
      try {
        const tick = await fetchSingleTicker(pair);
        if (tick) { const v = q * tick.price; vals[sym] = v; total += v; }
      } catch(e) {}
    }

    const drifts = [];
    for (const [sym, targetPct] of Object.entries(targetAllocation)) {
      const actualVal  = vals[sym] || 0;
      const actualPct  = total > 0 ? (actualVal / total) * 100 : 0;
      const drift      = actualPct - targetPct;
      if (Math.abs(drift) >= 5) {
        drifts.push({
          sym, targetPct, actualPct: parseFloat(actualPct.toFixed(1)),
          drift: parseFloat(drift.toFixed(1)),
          action: drift > 0 ? 'REDUCE' : 'INCREASE',
          valueAUD: parseFloat(actualVal.toFixed(2)),
        });
      }
    }

    // Alert via Telegram if any significant drift
    if (drifts.length > 0) {
      const msg = `⚖️ <b>Portfolio Allocation Drift!</b>\n\n` +
        drifts.map(d => `${d.action === 'REDUCE' ? '🔴' : '🟢'} <b>${d.sym}</b>: ${d.actualPct}% vs target ${d.targetPct}% (${d.drift > 0 ? '+' : ''}${d.drift}%)`).join('\n') +
        `\n\nTotal portfolio: ${fmtAUDServer(total)}`;
      sendTelegram(msg);
    }

    res.json({ success: true, data: { drifts, total, values: vals } });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════
// v4.0: ON-CHAIN DATA
// Whale movements, exchange flows, network health via Claude web search
// ══════════════════════════════════════════════════════════════
app.get('/api/onchain/:sym', requireAuth, async (req, res) => {
  try {
    const sym     = req.params.sym.toUpperCase();
    const cached  = onChainCache[sym];

    // Cache for 2 hours
    if (cached && (Date.now() - cached.fetchedAt) < 2 * 60 * 60 * 1000) {
      return res.json({ success: true, data: cached.data, cached: true });
    }

    const prompt = `Search for current on-chain data and network metrics for ${sym} cryptocurrency.
Find: 1) Large whale transactions in last 24h 2) Exchange inflows/outflows 3) Active addresses trend 4) Network hash rate or validator count 5) Any unusual on-chain activity.

Return ONLY this JSON (no markdown):
{
  "whaleActivity": "brief description of large transactions",
  "exchangeFlow": "net inflow or outflow from exchanges",
  "activeAddresses": "trend up/down/stable with number if available",
  "networkHealth": "strong/moderate/weak with brief reason",
  "bullishSignals": ["signal1", "signal2"],
  "bearishSignals": ["signal1", "signal2"],
  "overallOnChainScore": 6,
  "summary": "one sentence overall assessment"
}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const raw  = await response.json();
    const text = (raw.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    const clean = text.replace(/```json|```/g, '').trim();
    const data  = JSON.parse(clean);

    onChainCache[sym] = { data, fetchedAt: Date.now() };
    console.log(`[ON-CHAIN] ${sym}: score ${data.overallOnChainScore}/10`);
    res.json({ success: true, data });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start Server ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║        KRAKN·AI Bot Server v4.0        ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  Port:     ${PORT}                         ║`);
  console.log(`║  Currency: 🇦🇺 AUD                     ║`);
  console.log(`║  Keys:     ${!!(KRAKEN_API_KEY&&KRAKEN_API_SECRET)?'✅':'❌'}                         ║`);
  console.log(`║  AI:       ${!!(process.env.ANTHROPIC_API_KEY)?'✅':'❌'}                         ║`);
  console.log(`║  Telegram: ${!!(TELEGRAM_TOKEN&&TELEGRAM_CHAT_ID)?'✅':'❌'}                         ║`);
  console.log('╚════════════════════════════════════════╝');
  console.log('');
  // Load saved settings first — restores all config from last session
  loadData();
  // Schedule recurring tasks
  scheduleAdvisor();
  scheduleBuyCheck();
  scheduleDCA();
  // Volume anomaly check every 15 minutes (Sprint 1)
  setInterval(async () => { try { await checkVolumeAnomalies(); } catch(e) { console.error("[VOLUME]", e.message); } }, 15 * 60 * 1000);
  setTimeout(async () => { try { await checkVolumeAnomalies(); } catch(e){} }, 90000);

  // Smart money wallet scanner — every 15 minutes
  setInterval(async () => {
    try { await checkSmartMoneySignals(); }
    catch(e) { console.error('[SMART MONEY] Scan error:', e.message); }
  }, 15 * 60 * 1000);
  setTimeout(async () => {
    try { await checkSmartMoneySignals(); }
    catch(e) { console.error('[SMART MONEY] First scan error:', e.message); }
  }, 3 * 60 * 1000);

  // Macro event calendar — check every 30 minutes
  setInterval(async () => {
    try { await checkMacroEvents(); }
    catch(e) { console.error('[MACRO] Check error:', e.message); }
  }, 30 * 60 * 1000);
  setTimeout(async () => { try { await checkMacroEvents(); } catch(e){} }, 2 * 60 * 1000);

  // Grid trading — check every 5 minutes
  setInterval(async () => {
    try { await checkGridOrders(); }
    catch(e) { console.error('[GRID] Check error:', e.message); }
  }, 5 * 60 * 1000);

  // Portfolio rebalancing — check every 4 hours
  setInterval(async () => {
    try { await checkAndRebalance(); }
    catch(e) { console.error('[REBALANCE] Error:', e.message); }
  }, 4 * 60 * 60 * 1000);

  // Correlation matrix — build once on startup then every 6 hours
  setTimeout(async () => { try { await buildCorrelationMatrix(); } catch(e){} }, 5 * 60 * 1000);
  setInterval(async () => {
    try { await buildCorrelationMatrix(); }
    catch(e) { console.error('[CORRELATION] Build error:', e.message); }
  }, 6 * 60 * 60 * 1000);
  // Daily portfolio snapshot for performance graph (every 6 hours)
  setTimeout(async () => {
    try { await recordPortfolioSnapshot(); } catch(e) { console.error('[PORTFOLIO] Snapshot error:', e.message); }
  }, 30000);
  setInterval(async () => {
    try { await recordPortfolioSnapshot(); } catch(e) { console.error('[PORTFOLIO] Snapshot error:', e.message); }
  }, 6 * 60 * 60 * 1000);
  setTimeout(registerTelegramWebhook, 3000);
  setTimeout(() => { if (advisorSettings.enabled) runAdvisor(); }, 15000);
});

module.exports = app;
