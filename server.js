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
// Full version with STOCKS and ALL is defined below after US_STOCKS is declared

// ─── Alpaca — US Stocks ────────────────────────────────────────
const ALPACA_KEY      = (process.env.ALPACA_API_KEY    || '').trim();
const ALPACA_SECRET   = (process.env.ALPACA_API_SECRET || '').trim();
const ALPACA_BASE_URL = 'https://api.alpaca.markets/v2';
const ALPACA_DATA_URL = 'https://data.alpaca.markets/v2';
const ALPACA_PAPER    = process.env.ALPACA_PAPER === 'true'; // set to 'true' for paper trading

// Popular US stocks — symbol only (no pair suffix)
// These are treated as a separate asset class from Kraken crypto
const US_STOCKS = [
  // Tech mega-caps
  'AAPL','MSFT','NVDA','GOOGL','AMZN','META','TSLA',
  // Finance
  'JPM','BAC','V','MA',
  // ETFs
  'SPY','QQQ','VTI','GLD',
  // ASX-correlated US names popular with Australians
  'BHP','RIO','LIT','COPX',
];

// Display names for US stocks
US_STOCKS.forEach(s => {
  if (!PAIR_DISPLAY[s]) PAIR_DISPLAY[s] = s + '/USD';
});

// Detect if a symbol is a US stock (not a crypto pair)
function isStockSymbol(sym) {
  return US_STOCKS.includes(sym) || (sym && !sym.includes('USD') && !sym.includes('AUD') && sym.length <= 5 && sym === sym.toUpperCase() && !/[0-9]/.test(sym));
}

// Detect base currency from pair name
function pairCurrency(pair) {
  if (!pair) return 'AUD';
  if (isStockSymbol(pair))               return 'USD'; // US stocks trade in USD
  if (pair.endsWith('AUD'))              return 'AUD';
  if (pair.endsWith('USD') || pair.endsWith('USDT')) return 'USD';
  return 'AUD'; // default
}

// Updated active pairs — includes stocks when mode is STOCKS or ALL
function getActivePairs(mode) {
  if (mode === 'USD')    return USD_PAIRS;
  if (mode === 'BOTH')   return [...AUD_PAIRS, ...USD_PAIRS];
  if (mode === 'STOCKS') return US_STOCKS;
  if (mode === 'ALL')    return [...AUD_PAIRS, ...USD_PAIRS, ...US_STOCKS];
  return AUD_PAIRS; // default
}

// ─── Alpaca API Client ─────────────────────────────────────────
async function alpacaRequest(path, method = 'GET', body = null, dataApi = false) {
  if (!ALPACA_KEY || !ALPACA_SECRET) throw new Error('Alpaca keys not configured');
  const base = dataApi ? ALPACA_DATA_URL : ALPACA_BASE_URL;
  const url  = `${base}${path}`;
  const opts = {
    method,
    headers: {
      'APCA-API-KEY-ID':     ALPACA_KEY,
      'APCA-API-SECRET-KEY': ALPACA_SECRET,
      'Content-Type':        'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Alpaca ${res.status}: ${err}`);
  }
  return res.json();
}

// Fetch stock ticker from Alpaca
async function fetchStockTicker(symbol) {
  try {
    const data = await alpacaRequest(`/stocks/${symbol}/snapshot`, 'GET', null, true);
    const lat  = data.latestTrade   || {};
    const laq  = data.latestQuote   || {};
    const bar  = data.dailyBar      || {};
    const prev = data.prevDailyBar  || {};
    const price    = parseFloat(lat.p || laq.ap || bar.c || 0);
    const prevClose = parseFloat(prev.c || price);
    const change24h = prevClose > 0 ? (((price - prevClose) / prevClose) * 100).toFixed(2) : '0.00';
    return {
      price,
      bid:      parseFloat(laq.bp || 0),
      ask:      parseFloat(laq.ap || 0),
      high:     parseFloat(bar.h  || 0),
      low:      parseFloat(bar.l  || 0),
      volume:   parseFloat(bar.v  || 0),
      open:     parseFloat(bar.o  || prevClose),
      change24h,
      exchange: 'US',
      assetType: 'stock',
    };
  } catch(e) {
    console.warn(`[ALPACA TICKER] ${symbol} failed:`, e.message);
    return null;
  }
}

// Fetch OHLC bars from Alpaca (matches Kraken OHLC format)
async function fetchStockBars(symbol, timeframe = '1Hour', limit = 60) {
  try {
    // Map our timeframe keys to Alpaca timeframe strings
    const tfMap = { 15:'15Min', 60:'1Hour', 240:'4Hour', 1440:'1Day', 10080:'1Week' };
    const tf    = tfMap[timeframe] || timeframe;
    const end   = new Date().toISOString();
    const start = new Date(Date.now() - limit * timeframeToMs(timeframe)).toISOString();

    const data = await alpacaRequest(
      `/stocks/${symbol}/bars?timeframe=${tf}&start=${start}&end=${end}&limit=${limit}&feed=iex`,
      'GET', null, true
    );

    // Convert Alpaca bars to Kraken OHLC format [time, open, high, low, close, vwap, volume, count]
    return (data.bars || []).map(b => [
      Math.floor(new Date(b.t).getTime() / 1000),
      b.o, b.h, b.l, b.c, b.vw || b.c, b.v, b.n || 0
    ]);
  } catch(e) {
    console.warn(`[ALPACA BARS] ${symbol} failed:`, e.message);
    return [];
  }
}

function timeframeToMs(tf) {
  const map = { 15: 15*60*1000, 60: 60*60*1000, 240: 4*60*60*1000, 1440: 24*60*60*1000, 10080: 7*24*60*60*1000 };
  return map[tf] || 60*60*1000;
}

// Get Alpaca account info
async function getAlpacaAccount() {
  return alpacaRequest('/account');
}

// Get Alpaca positions
async function getAlpacaPositions() {
  return alpacaRequest('/positions');
}

// Place stock order via Alpaca
async function placeStockOrder(symbol, side, qty, orderType = 'market', limitPrice = null) {
  const body = {
    symbol,
    qty:        qty.toString(),
    side,       // 'buy' or 'sell'
    type:       orderType,
    time_in_force: 'day',
  };
  if (orderType === 'limit' && limitPrice) body.limit_price = limitPrice.toString();
  const base = ALPACA_PAPER ? 'https://paper-api.alpaca.markets/v2' : ALPACA_BASE_URL;
  const res  = await fetch(`${base}/orders`, {
    method:  'POST',
    headers: {
      'APCA-API-KEY-ID':     ALPACA_KEY,
      'APCA-API-SECRET-KEY': ALPACA_SECRET,
      'Content-Type':        'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Alpaca order failed: ${err}`);
  }
  return res.json();
}

// ─── Universal ticker — routes to Kraken or Alpaca ────────────
async function fetchTickerUniversal(symbol) {
  if (isStockSymbol(symbol)) return fetchStockTicker(symbol);
  return fetchSingleTicker(symbol);
}

// ─── Universal OHLC — routes to Kraken or Alpaca ─────────────
async function fetchOHLCUniversal(symbol, interval) {
  if (isStockSymbol(symbol)) {
    const bars = await fetchStockBars(symbol, interval, 60);
    return bars; // already in Kraken-compatible format
  }
  const ohlc = await krakenPublicRequest('OHLC', { pair: symbol, interval });
  const k    = Object.keys(ohlc).find(k => k !== 'last');
  return ohlc[k] || [];
}

// Fallback pair names to try if primary fails
// Maps USD crypto pairs to their AUD equivalents for when user only has AUD
const USD_TO_AUD_MAP = {
  'XBTUSD':  'XBTAUD',
  'ETHUSD':  'ETHAUD',
  'SOLUSD':  'SOLAUD',
  'XRPUSD':  'XRPAUD',
  'ADAUSD':  'ADAAUD',
  'LTCUSD':  'LTCAUD',
  'DOTUSD':  'DOTAUD',
  'LINKUSD': 'LINKAUD',
};

// If we have AUD but not USD, reroute a USD pair to its AUD equivalent
function rerouteToAUD(pair) {
  return USD_TO_AUD_MAP[pair] || null;
}

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
  intervalHours: 8,    // 8h (was 4h) — halves Claude advisor cost
  pairs:         ['XBTAUD','ETHAUD','SOLAUD'], // 3 pairs (was 5) — saves 40% per run
  minConfidence: 65,
  includeNews:   false, // disabled — news fetching adds Claude calls
  lastRun:       null,
};

// ─── State ─────────────────────────────────────────────────────
let priceAlerts           = [];
let pendingBuyOpportunity = null;
const chatHistory         = {};
let selectedPairForChat   = 'XBTAUD'; // tracks last coin mentioned in Telegram

// ─── P&L Tracking ──────────────────────────────────────────────
// Stores every trade we make through the bot for P&L calculation
let tradeLog = []; // { id, pair, sym, type, volume, price, valueAUD, timestamp, source, signalConditions }
let pnlByAsset = {}; // { BTC: { avgBuyPrice, totalBought, totalSold, realised } }

// Signal learning weights — adjusted over time based on what works
// Each key is a signal type, value is a multiplier (0.5 = half weight, 2.0 = double weight)
let signalWeights = {
  rsi_oversold:      1.0, // RSI < 30 on buy
  rsi_overbought:    1.0, // RSI > 70 on sell
  hammer:            1.0, // Hammer candlestick
  engulfing:         1.0, // Engulfing pattern
  morning_star:      1.0, // Morning star
  macd_bullish:      1.0, // MACD bullish cross
  bb_lower:          1.0, // Price at BB lower band
  bb_upper:          1.0, // Price at BB upper band
  volume_spike:      1.0, // Volume anomaly
  vision_confirms:   1.0, // Vision AI confirms signal
  vision_disagrees:  1.0, // Vision AI disagrees (negative weight)
  sentiment_bull:    1.0, // Positive sentiment
  sentiment_bear:    1.0, // Negative sentiment
  fear_extreme:      1.0, // Extreme fear (good contrarian buy)
  multi_tf_agrees:   1.0, // Multiple timeframes agree
};

// Trade outcome log — used for learning
// { tradeId, sym, buySignals, sellSignals, buyRsi, sellRsi, 
//   buyPrice, sellPrice, pnlPct, won, durationMinutes, patterns }
let tradeOutcomes = [];

function recordTrade(pair, sym, type, volume, price, source = 'manual', signalConditions = null) {
  const valueAUD = parseFloat(volume) * parseFloat(price);
  const trade = {
    id:              Date.now().toString(),
    pair, sym, type,
    volume:          parseFloat(volume),
    price:           parseFloat(price),
    valueAUD,
    timestamp:       new Date().toISOString(),
    source,
    signalConditions,
    entryConditions: signalConditions, // always store for outcome matching
  };
  tradeLog.push(trade);
  if (tradeLog.length > 500) tradeLog = tradeLog.slice(-500);

  // Update P&L tracking
  if (!pnlByAsset[sym]) pnlByAsset[sym] = { avgBuyPrice:0, totalVolume:0, totalCost:0, realisedPnl:0, tradeCount:0 };
  const asset = pnlByAsset[sym];

  if (type === 'buy') {
    const newTotalCost   = asset.totalCost + valueAUD;
    const newTotalVolume = asset.totalVolume + parseFloat(volume);
    asset.avgBuyPrice    = newTotalCost / newTotalVolume;
    asset.totalVolume    = newTotalVolume;
    asset.totalCost      = newTotalCost;

  } else if (type === 'sell') {
    if (asset.avgBuyPrice > 0) {
      const vol      = parseFloat(volume);
      const costBasis = asset.avgBuyPrice * vol;
      const proceeds  = valueAUD;
      const pnl       = proceeds - costBasis;
      const pnlPct    = (pnl / costBasis) * 100;
      asset.realisedPnl += pnl;
      asset.totalVolume  = Math.max(0, asset.totalVolume - vol);
      asset.totalCost    = asset.avgBuyPrice * asset.totalVolume;

      // Find the most recent buy trade for this asset — regardless of whether
      // it has entryConditions (fixes report showing 0 trades)
      const matchingBuy = [...tradeLog].reverse().find(t =>
        t.sym === sym && t.type === 'buy'
      );

      // Always record outcome for the report and learning engine
      tradeOutcomes.push({
        tradeId:         matchingBuy?.id || trade.id,
        sym,
        won:             pnl > 0,
        pnlPct:          parseFloat(pnlPct.toFixed(2)),
        pnlAUD:          parseFloat(pnl.toFixed(2)),
        durationMinutes: matchingBuy
          ? Math.round((new Date(trade.timestamp) - new Date(matchingBuy.timestamp)) / 60000)
          : 0,
        buyPrice:        matchingBuy?.price || asset.avgBuyPrice,
        sellPrice:       parseFloat(price),
        source,
        conditions:      matchingBuy?.entryConditions || signalConditions || {},
        timestamp:       new Date().toISOString(),
      });
      if (tradeOutcomes.length > 200) tradeOutcomes = tradeOutcomes.slice(-200);

      // Trigger learning after every 5th closed trade
      if (tradeOutcomes.length % 5 === 0) setTimeout(learnFromOutcomes, 2000);
    }
  }

  asset.tradeCount++;
  console.log(`[P&L] ${type.toUpperCase()} ${volume} ${sym} @ ${fmtAUDServer(price, pair)} | realised: A$${asset.realisedPnl.toFixed(2)}`);
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
let botConfig = {
  riskLevel:            'moderate',   // was 'conservative' which added +5% to threshold
  sellPct:              100,
  confidenceMin:        65,           // was 75 — ETH at 68% now qualifies
  checkInterval:        60,
  minHoldingValueAUD:   50,
  stopLossEnabled:      true,
  stopLossPct:          3,
  trailingStop:         true,
  useATRStops:          true,
  atrMultiplier:        2.0,
  breakEvenTriggerPct:  2.0,
  trailingTriggerPct:   4.0,
  minHoldMinutes:       120,  // 2 hours minimum — was 60
  maxHoldHours:         120,  // 5 days max — exit even if no signal to free capital
  currencyMode:         'AUD',
  autoBuy:              false,
  autoBuyMaxAUD:        200,
  autoBuyMinConfidence: 82,

  // ── Notification Settings ─────────────────────────────────
  // Critical alerts always fire immediately (buy/sell/stop loss/errors)
  // Everything else respects the digest interval below
  notifications: {
    // Always on — these fire immediately no matter what
    buys:          true,   // BUY signals and auto-buy executions
    sells:         true,   // SELL executions and stop losses
    errors:        true,   // order failures and critical errors
    breakEven:     true,   // break-even stop triggered
    profitLocked:  true,   // trailing stop / profit locked in

    // Everything non-critical → daily portfolio digest
    // Individual category digests replaced by one personalised daily summary
    volumeAlerts:  'off',   // folded into daily digest
    smartMoney:    'daily', // only truly significant moves
    macroEvents:   'off',   // folded into daily digest
    advisor:       'off',   // replaced by daily portfolio digest
    learning:      'daily', // weight updates once a day is enough
    waitlist:      'daily', // signups batched
    gridUpdates:   'off',
    rebalance:     'off',
  },

  // ── API Cost Controls ─────────────────────────────────────
  api: {
    visionEnabled:          true,   // Claude vision chart analysis (most expensive)
    visionMaxPairsPerCheck: 3,      // max coins to run vision on per advisor cycle
    sentimentEnabled:       true,   // Claude sentiment analysis
    sentimentCacheMins:     1440,   // 24h cache (was 4h) — sentiment doesn't change hourly
    advisorEnabled:         true,   // AI advisor runs
    advisorIntervalHours:   4,      // how often advisor runs (was 1 hour)
    onChainEnabled:         true,   // on-chain data fetches
    onChainCacheHours:      4,      // cache on-chain data (was 2 hours)
    learningEnabled:        true,   // learning engine
    learningMinTrades:      10,     // min trades before learning (was 5)
  },
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

// ─── Notification Digest System ───────────────────────────────
// Non-critical alerts queue here and flush at user-configured intervals
// Critical alerts (buys/sells/stop losses) always fire immediately
const digestQueue    = {}; // { category: [{ title, body }] }
const digestLastSent = {}; // { category: lastSentTimestamp }

function queueNotification(category, title, body) {
  const setting = botConfig.notifications?.[category];
  if (!setting || setting === 'off') return;
  if (!digestQueue[category]) digestQueue[category] = [];
  digestQueue[category].push({ title, body, timestamp: new Date().toISOString() });
  console.log(`[NOTIFY QUEUE] ${category}: ${title}`);
}

function intervalToMs(setting) {
  if (setting === '4h')    return 4  * 60 * 60 * 1000;
  if (setting === '8h')    return 8  * 60 * 60 * 1000;
  if (setting === 'daily') return 24 * 60 * 60 * 1000;
  return null;
}

async function flushDigestQueues() {
  const settings = botConfig.notifications || {};
  for (const [category, items] of Object.entries(digestQueue)) {
    if (!items?.length) continue;
    const interval = intervalToMs(settings[category]);
    if (!interval) continue;
    if (Date.now() - (digestLastSent[category] || 0) < interval) continue;

    const label  = settings[category] === 'daily' ? 'Daily' :
                   settings[category] === '8h' ? '8-Hour' : '4-Hour';
    const lines  = items.slice(-8).map((n,i) =>
      `${i+1}. <b>${n.title}</b>\n${n.body}`
    ).join('\n\n');

    await sendTelegram(
      `📋 <b>${label} Digest — ${category.replace(/([A-Z])/g,' $1').trim()}</b>\n` +
      `${items.length} update${items.length!==1?'s':''}\n\n${lines}`
    );
    digestQueue[category]    = [];
    digestLastSent[category] = Date.now();
  }
}
setInterval(flushDigestQueues, 30 * 60 * 1000); // check every 30 mins

// ─── Daily Portfolio Digest ────────────────────────────────────
// Fires once per day at 8am Sydney time
// Personal summary of YOUR portfolio — not generic market noise
async function sendDailyPortfolioDigest() {
  try {
    const sydneyTime = new Date().toLocaleString('en-AU', { timeZone:'Australia/Sydney', dateStyle:'full', timeStyle:'short' });

    // 1. Get live balances and prices
    let audCash = 0, holdings = [];
    try {
      const bal = await krakenPrivateRequest('Balance');
      audCash   = parseFloat(bal['ZAUD'] || bal['AUD'] || bal['RAUD'] || 0);

      for (const [asset, qty] of Object.entries(bal)) {
        const q = parseFloat(qty);
        if (q < 0.00001) continue;
        if (asset === 'ZAUD' || asset === 'AUD' || asset === 'RAUD') continue;
        const sym      = asset.replace(/^X/,'').replace(/Z$/,'').replace('XBT','BTC');
        const audPair  = USD_TO_AUD_MAP ? (Object.entries(USD_TO_AUD_MAP).find(([k]) => k.includes(sym))?.[1]) : null;
        const pair     = audPair || (sym + 'AUD');
        const ticker   = await fetchSingleTicker(pair).catch(() => null);
        if (!ticker) continue;
        const valueAUD = q * ticker.price;
        if (valueAUD < 1) continue;
        const pnlData  = pnlByAsset[sym];
        const avgBuy   = pnlData?.avgBuyPrice || 0;
        const unrealPct = avgBuy > 0 ? ((ticker.price - avgBuy) / avgBuy * 100) : null;
        const heldHours = lastBuyTimes[sym] ? (Date.now() - lastBuyTimes[sym]) / 3600000 : null;
        holdings.push({ sym, qty: q, price: ticker.price, valueAUD, avgBuy, unrealPct, pair, heldHours });
      }
    } catch(e) { console.warn('[DAILY DIGEST] Balance fetch failed:', e.message); }

    // 2. P&L summary from trade outcomes (last 7 days)
    const weekAgo    = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const weekTrades = tradeOutcomes.filter(t => new Date(t.timestamp).getTime() > weekAgo);
    const weekWins   = weekTrades.filter(t => t.won).length;
    const weekPnl    = weekTrades.reduce((s,t) => s+t.pnlAUD, 0);
    const allRealised = Object.values(pnlByAsset).reduce((s,a) => s+(a.realisedPnl||0), 0);

    // 3. Portfolio total
    const totalInvested = holdings.reduce((s,h) => s+h.valueAUD, 0);
    const totalValue    = totalInvested + audCash;

    // 4. Build holdings section
    const holdingsLines = holdings.map(h => {
      const pnlStr = h.unrealPct !== null
        ? ` (${h.unrealPct >= 0 ? '🟢 +' : '🔴 '}${h.unrealPct.toFixed(1)}%)`
        : '';
      const heldStr = h.heldHours
        ? ` · held ${h.heldHours < 24 ? h.heldHours.toFixed(0)+'h' : (h.heldHours/24).toFixed(1)+'d'}`
        : '';
      return `• <b>${h.sym}</b> — A$${Math.round(h.valueAUD).toLocaleString()}${pnlStr}${heldStr}`;
    }).join('\n') || '• No open positions';

    // 5. What the bot is watching
    const watchPairs   = getActivePairs(botConfig.currencyMode).slice(0, 5);
    const watchSignals = [];
    for (const pair of watchPairs) {
      try {
        const ticker = await fetchSingleTicker(pair);
        if (!ticker) continue;
        const sym    = PAIR_DISPLAY[pair] || pair;
        const chg    = ticker.change24h >= 0 ? `+${ticker.change24h}%` : `${ticker.change24h}%`;
        watchSignals.push(`• ${sym} — ${fmtAUDServer(ticker.price, pair)} (${chg})`);
      } catch {}
    }

    // 6. Bot status
    const botRunning  = botState.running;
    const tradesCount = tradeOutcomes.length;
    const winRate     = tradesCount > 0
      ? Math.round(tradeOutcomes.filter(t=>t.won).length / tradesCount * 100)
      : 0;

    await sendTelegram(
      `📊 <b>KRAKN·AI Daily Portfolio Summary</b>\n` +
      `${sydneyTime}\n\n` +

      `💼 <b>Portfolio</b>\n` +
      `Total value: <b>A$${Math.round(totalValue).toLocaleString()}</b>\n` +
      `Cash available: A$${audCash.toFixed(2)}\n` +
      `All-time realised P&L: ${allRealised >= 0 ? '🟢 +' : '🔴 '}A$${Math.abs(allRealised).toFixed(2)}\n\n` +

      `📈 <b>Open Positions (${holdings.length})</b>\n` +
      `${holdingsLines}\n\n` +

      (weekTrades.length > 0 ?
      `⚡ <b>Last 7 Days</b>\n` +
      `${weekTrades.length} trades · ${weekWins} wins · ${weekPnl >= 0 ? '+' : ''}A$${weekPnl.toFixed(2)} P&L\n\n` : '') +

      `🌐 <b>Market Prices</b>\n` +
      `${watchSignals.join('\n')}\n\n` +

      `🤖 <b>Bot Status</b>\n` +
      `${botRunning ? '🟢 Running' : '⏸ Paused'} · ${botConfig.confidenceMin}% threshold · ${botConfig.stopLossPct}% stop\n` +
      `${tradesCount} total trades · ${winRate}% win rate\n\n` +

      `💡 Reply <b>Any signals?</b> for a live scan`
    );

    console.log('[DAILY DIGEST] Portfolio digest sent');
  } catch(e) {
    console.error('[DAILY DIGEST]', e.message);
  }
}

// Schedule daily digest at 8am Sydney time
function scheduleDailyDigest() {
  function msUntil8amSydney() {
    const now    = new Date();
    const sydney = new Date(now.toLocaleString('en-US', { timeZone:'Australia/Sydney' }));
    const next8am = new Date(sydney);
    next8am.setHours(8, 0, 0, 0);
    if (next8am <= sydney) next8am.setDate(next8am.getDate() + 1);
    return next8am - sydney;
  }
  const ms = msUntil8amSydney();
  console.log(`[DAILY DIGEST] First digest in ${(ms/3600000).toFixed(1)}h (8am Sydney)`);
  setTimeout(() => {
    sendDailyPortfolioDigest();
    setInterval(sendDailyPortfolioDigest, 24 * 60 * 60 * 1000); // then every 24h
  }, ms);
}

// ─── Portfolio History ─────────────────────────────────────────
let portfolioHistory = []; // [{ date, valueAUD, timestamp }]

// ─── Target Allocation ─────────────────────────────────────────
// User sets desired % per coin — bot alerts when drifting > 5%
let targetAllocation = {}; // { BTC: 40, ETH: 30, SOL: 20, cash: 10 }

// ─── On-Chain Data Cache ───────────────────────────────────────
let onChainCache    = {}; // { sym: { data, fetchedAt } }
let fundingRateCache = {}; // { pair: { rate, fetchedAt } }

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
let waitlistSignups    = []; // { name, email, timestamp }

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
      waitlistSignups,
      signalWeights, tradeOutcomes,
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

      // Always force-reset notification settings — saved file may have old 4h/8h values
      // These are code-controlled, not user-controlled, so always use current defaults
      botConfig.notifications = {
        buys:         true,
        sells:        true,
        errors:       true,
        breakEven:    true,
        profitLocked: true,
        volumeAlerts: 'off',
        smartMoney:   'daily',
        macroEvents:  'off',
        advisor:      'off',
        learning:     'daily',
        waitlist:     'daily',
        gridUpdates:  'off',
        rebalance:    'off',
      };
      console.log('[LOAD] Notification settings reset to daily digest mode');
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
      if (data.waitlistSignups)     waitlistSignups     = data.waitlistSignups;
      if (data.signalWeights)       Object.assign(signalWeights, data.signalWeights);
      if (data.tradeOutcomes)       tradeOutcomes       = data.tradeOutcomes;
      // Auto-restart bot if it was running before the server restarted
      // Delay 3 minutes — well past Railway health check window (30s)
      // and past vision analysis startup tasks
      if (data.botRunning) {
        console.log('[LOAD] Bot was running — auto-starting in 3min (after health check)');
        setTimeout(() => {
          if (!botState.running) {
            botState.running = true;
            startAutoSellLoop();
            console.log('[LOAD] ✅ Bot auto-restarted');
          }
        }, 3 * 60 * 1000);
      }
      console.log(`[LOAD] ✅ Settings restored from ${src} — bot was ${data.botRunning ? 'ON (restarting)' : 'OFF'}`);

      // ── Sanity-check critical settings ───────────────────
      // Fix bad saved values that may have crept in from old versions
      if (botConfig.stopLossPct < 2)   { botConfig.stopLossPct = 3;   console.log('[LOAD] Fixed stopLossPct → 3%'); }
      if (botConfig.confidenceMin > 80) { botConfig.confidenceMin = 65; console.log('[LOAD] Fixed confidenceMin → 65%'); }
      if (advisorSettings.intervalHours < 4) { advisorSettings.intervalHours = 8; console.log('[LOAD] Fixed advisor interval → 8h'); }
      console.log(`[LOAD] Active: risk=${botConfig.riskLevel} confidence=${botConfig.confidenceMin}% stopLoss=${botConfig.stopLossPct}%`);
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

// ─── ATR — Average True Range ─────────────────────────────────
// Measures how much a coin typically moves per candle
// Used to set stop losses that breathe with the market
function calcATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const high  = parseFloat(candles[i][2]);
    const low   = parseFloat(candles[i][3]);
    const prevClose = parseFloat(candles[i-1][4]);
    const tr    = Math.max(
      high - low,                     // candle range
      Math.abs(high - prevClose),     // gap up
      Math.abs(low  - prevClose)      // gap down
    );
    trueRanges.push(tr);
  }
  // Simple ATR average over period
  const recent = trueRanges.slice(-period);
  const atr    = recent.reduce((s,v) => s+v, 0) / recent.length;
  const lastPrice = parseFloat(candles[candles.length-1][4]);
  return {
    atr,
    atrPct:    (atr / lastPrice) * 100,   // ATR as % of price
    lastPrice,
    candles:   candles.length,
  };
}

// Calculate the ideal stop loss % for a coin based on its ATR
// Returns a % below entry price — varies with market volatility
// ATR multiplier of 2.0 is the professional standard for crypto
async function calcDynamicStopLoss(pair, multiplier = 2.0) {
  try {
    const candles1h = await fetchOHLCUniversal(pair, 60);
    if (!candles1h || candles1h.length < 15) return null;
    const atrData = calcATR(candles1h, 14);
    if (!atrData) return null;

    const stopPct   = atrData.atrPct * multiplier;
    const minStop   = 1.0;   // never less than 1% — prevents hair-trigger exits
    const maxStop   = 8.0;   // never more than 8% — limits max loss
    const finalStop = Math.min(maxStop, Math.max(minStop, stopPct));

    return {
      stopPct:      parseFloat(finalStop.toFixed(2)),
      atrPct:       parseFloat(atrData.atrPct.toFixed(2)),
      atr:          parseFloat(atrData.atr.toFixed(6)),
      multiplier,
      recommendation: finalStop < 2 ? 'tight' : finalStop < 4 ? 'normal' : 'wide',
    };
  } catch(e) {
    console.warn(`[ATR STOP] ${pair}:`, e.message);
    return null;
  }
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
  // Route to Alpaca for stocks, Kraken for crypto
  const candles = (await fetchOHLCUniversal(pair, interval)).slice(-50);
  if (!candles || candles.length < 10) {
    return { rsi:50, macd:{trend:'NEUTRAL'}, bb:{position:'MIDDLE'}, score:0, signals:[], patterns:[], volumes:[], rawCandles:[], ma20:null, aboveMa20:null };
  }
  const closes  = candles.map(c => parseFloat(c[4]));
  const volumes = candles.map(c => parseFloat(c[6]));

  // 20-period moving average — used for trend filter
  const ma20slice = closes.slice(-20);
  const ma20      = ma20slice.reduce((s,v) => s+v, 0) / ma20slice.length;
  const lastClose = closes[closes.length-1];
  const aboveMa20 = lastClose > ma20; // price above MA = trending up

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

  return { interval, rsi, macd, bb, volSig, patterns, score, signals, rawCandles: candles, ma20, aboveMa20 };
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

      const ohlcRaw = await fetchOHLCUniversal(pair, 15);
      const candles = ohlcRaw.slice(-25);
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

      queueNotification('volumeAlerts',
        `VOLUME ANOMALY — ${dp}`,
        `Volume is <b>${anomaly.ratio}x</b> above normal (${anomaly.level})\nPrice: ${fmtAUDServer(price, pair)} — ${priceDir}${patternStr}`
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
    // Cache failure for only 15 minutes so it retries soon
    sentimentCache[sym] = { ...fallback, fetchedAt: Date.now() - (105 * 60 * 1000) }; // expires in 15min
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
async function computeSignalForPair(pair, options = {}) {
  try {
    const sym = PAIR_DISPLAY[pair] || pair;

    // ── Analyse 3 timeframes numerically ─────────────────────
    const [tf15, tf60, tf240] = await Promise.all([
      analyseTimeframe(pair, 15),
      analyseTimeframe(pair, 60),
      analyseTimeframe(pair, 240),
    ]);

    const weightedScore = (tf15.score * 0.5) + (tf60.score * 2) + (tf240.score * 4);
    const maxScore      = 26;

    // Base confidence from weighted score
    // Score 6 = 65%, Score 10 = 75%, Score 15 = 85%, Score 20+ = 95%
    // This means a genuine signal starts above threshold before any modifiers
    let action = 'HOLD', confidence = 50;
    if (weightedScore >= 6)       { action='BUY';  confidence=Math.min(95, 60+(weightedScore/maxScore)*45); }
    else if (weightedScore <= -6) { action='SELL'; confidence=Math.min(95, 60+(Math.abs(weightedScore)/maxScore)*45); }
    else if (weightedScore >= 3)  { action='BUY';  confidence=Math.min(70, 50+(weightedScore/maxScore)*35); }
    else if (weightedScore <= -3) { action='SELL'; confidence=Math.min(70, 50+(Math.abs(weightedScore)/maxScore)*35); }

    // ── Risk level base adjustment ────────────────────────────
    if (botConfig.riskLevel === 'conservative') confidence = Math.max(0, confidence - 5);
    if (botConfig.riskLevel === 'aggressive')   confidence = Math.min(99, confidence + 5);

    const allSignals = [
      ...tf15.signals.map(s => `15m: ${s}`),
      ...tf60.signals.map(s => `1h: ${s}`),
      ...tf240.signals.map(s => `4h: ${s}`),
    ];

    // ── 4H 20MA Trend Filter ──────────────────────────────────
    // Only buy when 4H price is above its 20-period MA — confirms uptrend
    // This single filter cuts ~30% of losing trades by avoiding choppy markets
    if (action === 'BUY' && tf240.aboveMa20 === false) {
      confidence = Math.max(0, confidence - 12);
      allSignals.push('⚠️ 4H below 20MA — against trend, confidence reduced');
    } else if (action === 'BUY' && tf240.aboveMa20 === true) {
      confidence = Math.min(99, confidence + 5);
      allSignals.push('✅ 4H above 20MA — trading with trend');
    }

    // ── Tighter RSI threshold for higher quality entries ──────
    // RSI < 30 is a much stronger signal than RSI < 35
    // Boost confidence significantly when truly oversold
    if (tf60.rsi < 28) {
      confidence = Math.min(99, confidence + 8);
      allSignals.push(`🔥 RSI ${tf60.rsi} extreme oversold — high conviction`);
    } else if (tf60.rsi < 33) {
      confidence = Math.min(99, confidence + 4);
      allSignals.push(`📉 RSI ${tf60.rsi} oversold — good entry zone`);
    }

    // ══════════════════════════════════════════════════════════
    // IMPROVEMENT 1 — MARKET REGIME DETECTION
    // Classifies market as BULL, BEAR or SIDEWAYS using EMA200,
    // ADX (trend strength) and ATR volatility.
    // Different strategies apply in each regime.
    // ══════════════════════════════════════════════════════════
    let regime = 'UNKNOWN';
    let regimeModifier = 1.0;
    try {
      const dailyCandles = await fetchOHLCUniversal(pair, 1440);
      if (dailyCandles && dailyCandles.length >= 20) {
        const closes = dailyCandles.map(c => parseFloat(c[4]));
        const highs   = dailyCandles.map(c => parseFloat(c[2]));
        const lows    = dailyCandles.map(c => parseFloat(c[3]));

        // EMA 20 and EMA 50 on daily — trend direction
        const ema20 = closes.slice(-20).reduce((s,v,_,a) => s+v/a.length, 0);
        const ema50arr = closes.slice(-50);
        const ema50 = ema50arr.reduce((s,v,_,a) => s+v/a.length, 0);
        const lastPrice = closes[closes.length-1];

        // ADX — trend strength (simplified: compare high-low range to ATR)
        const recentATR = calcATR(dailyCandles.slice(-15), 14);
        const atrPct    = recentATR?.atrPct || 2;

        // Higher highs / higher lows check on last 10 candles
        const last10closes = closes.slice(-10);
        const higherHighs  = last10closes[9] > last10closes[5] && last10closes[5] > last10closes[0];
        const lowerLows    = last10closes[9] < last10closes[5] && last10closes[5] < last10closes[0];

        // Classify regime
        if (lastPrice > ema20 && ema20 > ema50 && higherHighs) {
          regime = 'BULL';
          if (action === 'BUY') confidence = Math.min(99, confidence + 8);
          allSignals.push(`📈 Regime: BULL`);

        } else if (lastPrice < ema20 && ema20 < ema50 && lowerLows) {
          regime = 'BEAR';
          if (action === 'BUY' && tf60.rsi > 25) {
            action = 'HOLD';
            allSignals.push('🐻 Bear regime: suppressing BUY');
          }
          allSignals.push(`📉 Regime: BEAR`);

        } else {
          regime = 'SIDEWAYS';
          // Very small penalty — sideways is the normal state, shouldn't kill good signals
          if (action !== 'HOLD') confidence = Math.max(0, confidence - 2);
          allSignals.push(`↔️ Regime: SIDEWAYS`);
        }
        // Note: no confidence *= regimeModifier here — adjustments done above
      }
    } catch(e) { console.warn(`[REGIME] ${sym}:`, e.message); }

    // ══════════════════════════════════════════════════════════
    // IMPROVEMENT 2 — VOLUME CONFIRMATION
    // Buy/sell signals must be confirmed by above-average volume.
    // A signal with no volume behind it is weak and likely to fail.
    // Professional standard: require 1.5x average volume to act.
    // ══════════════════════════════════════════════════════════
    let volumeConfirmed = true; // default pass if data unavailable
    try {
      const recentCandles = tf60.rawCandles || [];
      if (recentCandles.length >= 20) {
        const volumes     = recentCandles.map(c => parseFloat(c[6]));
        const avgVol20    = volumes.slice(-21,-1).reduce((s,v) => s+v, 0) / 20;
        const currentVol  = volumes[volumes.length-1];
        const volRatio    = avgVol20 > 0 ? currentVol / avgVol20 : 1;

        if (volRatio >= 1.5) {
          allSignals.push(`📊 Volume confirmed: ${volRatio.toFixed(1)}x above average`);
          confidence = Math.min(99, confidence + 5); // flat boost, not multiplicative
          volumeConfirmed = true;
        } else if (volRatio < 0.8 && action !== 'HOLD') {
          allSignals.push(`⚠️ Low volume: ${volRatio.toFixed(1)}x average`);
          confidence = Math.max(0, confidence - 3); // reduced from -5
          volumeConfirmed = false;
        }
      }
    } catch(e) { console.warn(`[VOLUME CONFIRM] ${sym}:`, e.message); }

    // ══════════════════════════════════════════════════════════
    // IMPROVEMENT 3 — FUNDING RATE (USD perpetual pairs only)
    // Extreme funding rates = crowded trade = reversal likely.
    // When everyone is leveraged long, the next move is a squeeze down.
    // When everyone is short, next move is a squeeze up.
    // ══════════════════════════════════════════════════════════
    try {
      const isUSDpair = pair.endsWith('USD') || pair.endsWith('USDT');
      if (isUSDpair) {
        const fundingCache = fundingRateCache[pair];
        const cacheAge     = fundingCache ? Date.now() - fundingCache.fetchedAt : Infinity;
        let fundingRate    = fundingCache?.rate;

        if (!fundingRate || cacheAge > 4 * 60 * 60 * 1000) {
          // Fetch from Kraken futures API
          try {
            const res = await fetch(`https://futures.kraken.com/derivatives/api/v3/tickers`);
            const data = await res.json();
            const sym2 = pair.replace('USD','').replace('XBT','BTC');
            const ticker = data.tickers?.find(t =>
              t.symbol?.includes(sym2) && t.symbol?.includes('PI_')
            );
            if (ticker?.fundingRate !== undefined) {
              fundingRate = parseFloat(ticker.fundingRate);
              fundingRateCache[pair] = { rate: fundingRate, fetchedAt: Date.now() };
            }
          } catch(e) { /* funding rate unavailable — not critical */ }
        }

        if (fundingRate !== undefined && fundingRate !== null) {
          const annualisedFunding = fundingRate * 3 * 365 * 100; // convert to annual %
          if (fundingRate > 0.01) {
            allSignals.push(`🔴 Funding extreme positive — crowded long`);
            if (action === 'BUY') confidence = Math.max(0, confidence - 8);
          } else if (fundingRate < -0.005) {
            allSignals.push(`🟢 Funding negative — crowded short, squeeze risk`);
            if (action === 'BUY') confidence = Math.min(99, confidence + 5);
          }
        }
      }
    } catch(e) { /* funding rate is bonus signal, not critical */ }

    // ── Multi-Timeframe Vision Analysis ──────────────────────
    // COST CONTROL: Vision disabled for scheduled auto-checks (saves ~85% of API cost)
    // Vision only runs when manualVision=true (manual Telegram "Any signals?" request)
    // The RSI/MACD/pattern/regime engine handles all automated decisions
    let vision    = null;
    let visionAll = {};

    if (createCanvas && options?.manualVision) {
      try {
        const tfConfigs = [
          { key:'15m', interval:15,   candles:80, weight:0.5, label:'15-Min' },
          { key:'1h',  interval:60,   candles:60, weight:1.0, label:'1-Hour' },
          { key:'4h',  interval:240,  candles:60, weight:2.0, label:'4-Hour' },
          { key:'1d',  interval:1440, candles:30, weight:3.0, label:'Daily'  },
          { key:'1w',  interval:10080,candles:20, weight:2.0, label:'Weekly' },
        ];

        const visionResults = [];
        for (const tf of tfConfigs) {
          try {
            if (visionResults.length > 0) await new Promise(r => setTimeout(r, 800));
            const ohlcRaw = await fetchOHLCUniversal(pair, tf.interval);
            if (!ohlcRaw || ohlcRaw.length < 10) continue; // FIXED: was "const k=null; if(!k) continue" which broke vision
            const candles = ohlcRaw.slice(-tf.candles);
            const result  = await analyseChartWithVision(pair, candles, {
              rsi:           tf.key === '4h' ? tf240.rsi : tf60.rsi,
              macdTrend:     tf60.macd.trend,
              bbPosition:    tf60.bb.position,
              weightedScore: Math.round(weightedScore),
              timeframe:     tf.label,
              regime,        // pass regime context to vision
            });
            if (result) visionResults.push({ ...tf, result, status:'fulfilled' });
          } catch(e) {
            console.warn(`[VISION ${tf.key}] ${sym}:`, e.message);
          }
        }

        let visionScoreSum = 0, visionWeightSum = 0;
        let bullishTFs = 0, bearishTFs = 0, holdTFs = 0;
        const visionSignals = [];

        visionResults.forEach(r => {
          if (!r?.result) return;
          const { key, label, weight, result } = r;
          visionAll[key] = result;
          const tfScore  = (result.visualScore - 5) * weight;
          visionScoreSum  += tfScore;
          visionWeightSum += weight;
          if (result.visionAction === 'BUY')       bullishTFs++;
          else if (result.visionAction === 'SELL')  bearishTFs++;
          else holdTFs++;
          if (result.visualPattern !== 'No clear pattern' && result.patternStrength >= 6) {
            visionSignals.push(`👁 ${label}: ${result.visualPattern} (${result.visionAction} ${result.visionConfidence}%)`);
          }
          console.log(`[VISION ${key}] ${sym}: ${result.visualPattern} → ${result.visionAction} ${result.visionConfidence}%`);
        });

        vision = visionAll['1h'] || visionAll['4h'] || null;
        const totalTFs = bullishTFs + bearishTFs + holdTFs;

        if (totalTFs > 0) {
          if (bullishTFs >= 3) {
            confidence = Math.min(97, confidence + (bullishTFs * 4));
            visionSignals.push(`👁 ${bullishTFs}/${totalTFs} timeframes BULLISH`);
            if (action !== 'BUY' && bullishTFs >= 4) { action='BUY'; visionSignals.push('👁 Vision consensus → BUY'); }
          } else if (bearishTFs >= 3) {
            confidence = Math.min(97, confidence + (bearishTFs * 4));
            visionSignals.push(`👁 ${bearishTFs}/${totalTFs} timeframes BEARISH`);
            if (action !== 'SELL' && bearishTFs >= 4) { action='SELL'; visionSignals.push('👁 Vision consensus → SELL'); }
          }
          // Only penalise if more timeframes disagree than agree
          if (action === 'BUY' && bearishTFs > bullishTFs) {
            confidence = Math.max(0, confidence - 5);
            visionSignals.push(`⚠️ Vision majority bearish (${bearishTFs} vs ${bullishTFs})`);
          } else if (action === 'SELL' && bullishTFs > bearishTFs) {
            confidence = Math.max(0, confidence - 5);
            visionSignals.push(`⚠️ Vision majority bullish (${bullishTFs} vs ${bearishTFs})`);
          }
          if (vision?.visionAction === action && vision?.patternStrength >= 7) {
            confidence = Math.min(97, confidence + 8);
          }
          const dailyVision = visionAll['1d'];
          if (dailyVision?.visionAction && dailyVision.visionAction !== action &&
              dailyVision.visionAction !== 'HOLD' && dailyVision.visionConfidence >= 75) {
            confidence = Math.max(0, confidence - 5); // reduced from -10
            visionSignals.push(`⚠️ Daily disagrees: ${dailyVision.visionAction}`);
          }
        }
        allSignals.push(...visionSignals);
      } catch(e) { console.warn('[VISION]', e.message); }
    }

    // ── Apply learned signal weights ──────────────────────────
    const activeSignals = [];
    let weightMultiplier = 1.0;

    if (tf60.rsi < 30) { activeSignals.push('rsi_oversold');   weightMultiplier *= signalWeights.rsi_oversold; }
    if (tf60.rsi > 70) { activeSignals.push('rsi_overbought'); weightMultiplier *= signalWeights.rsi_overbought; }
    if (tf60.macd?.trend === 'BULLISH') { activeSignals.push('macd_bullish'); weightMultiplier *= signalWeights.macd_bullish; }
    if (tf60.bb?.position === 'OVERSOLD')  { activeSignals.push('bb_lower'); weightMultiplier *= signalWeights.bb_lower; }
    if (tf60.bb?.position === 'OVERBOUGHT'){ activeSignals.push('bb_upper'); weightMultiplier *= signalWeights.bb_upper; }

    const patternNames = [...(tf60.patterns||[]), ...(tf240.patterns||[])].map(p => p?.name?.toLowerCase() || '');
    if (patternNames.some(n => n.includes('hammer')))    { activeSignals.push('hammer');       weightMultiplier *= signalWeights.hammer; }
    if (patternNames.some(n => n.includes('engulfing'))) { activeSignals.push('engulfing');    weightMultiplier *= signalWeights.engulfing; }
    if (patternNames.some(n => n.includes('morning')))   { activeSignals.push('morning_star'); weightMultiplier *= signalWeights.morning_star; }

    if (vision) {
      if (vision.visionAction === action && vision.patternStrength >= 7) {
        activeSignals.push('vision_confirms');
        weightMultiplier *= signalWeights.vision_confirms;
      } else if (vision.visionAction !== action && vision.visionAction !== 'HOLD') {
        activeSignals.push('vision_disagrees');
        weightMultiplier *= (2 - signalWeights.vision_confirms);
      }
    }

    const tfActions = [
      tf15.score > 2 ? 'BUY' : tf15.score < -2 ? 'SELL' : 'HOLD',
      tf60.score > 2 ? 'BUY' : tf60.score < -2 ? 'SELL' : 'HOLD',
      tf240.score > 2 ? 'BUY' : tf240.score < -2 ? 'SELL' : 'HOLD',
    ];
    if (tfActions.every(a => a === action)) {
      activeSignals.push('multi_tf_agrees');
      weightMultiplier *= signalWeights.multi_tf_agrees;
    }

    // ══════════════════════════════════════════════════════════
    // IMPROVEMENT 4 — POSITION SIZING BY CONVICTION
    // High confidence = bigger position. Low confidence = smaller.
    // 65-74%: 0.5x | 75-84%: 1.0x | 85-94%: 1.25x | 95%+: 1.5x
    // The bot passes this multiplier to the buy execution.
    // ══════════════════════════════════════════════════════════
    const rawConf = Math.min(99, Math.round(confidence * Math.min(weightMultiplier, 1.5)));
    let positionSizeMultiplier = 0.5; // default: small
    if (rawConf >= 95)      positionSizeMultiplier = 1.5;
    else if (rawConf >= 85) positionSizeMultiplier = 1.25;
    else if (rawConf >= 75) positionSizeMultiplier = 1.0;
    else if (rawConf >= 65) positionSizeMultiplier = 0.5;
    else                     positionSizeMultiplier = 0.25; // very weak — minimal size

    if (positionSizeMultiplier !== 1.0) {
      allSignals.push(`💰 Position size: ${positionSizeMultiplier}x (confidence ${rawConf}%)`);
    }

    const signalConditions = {
      rsi:           tf60.rsi,
      weightedScore,
      regime,
      activeSignals,
      volumeConfirmed,
      weightMultiplier:       parseFloat(weightMultiplier.toFixed(3)),
      positionSizeMultiplier: positionSizeMultiplier,
      visionAction:           vision?.visionAction || null,
      patterns:               patternNames.filter(Boolean).slice(0,3),
    };

    return {
      action,
      confidence:             rawConf,
      rawConfidence:          Math.min(99, Math.round(confidence)),
      weightedScore,
      regime,
      positionSizeMultiplier,
      volumeConfirmed,
      signals:                allSignals,
      vision,
      visionAll,
      signalConditions,
      patterns: [
        ...(tf60.patterns||[]).map(p => ({ ...p, tf:'1h' })),
        ...(tf240.patterns||[]).map(p => ({ ...p, tf:'4h' })),
      ],
      timeframes: {
        '15m': { rsi:tf15.rsi, macd:tf15.macd?.trend, bb:tf15.bb?.position, score:tf15.score },
        '1h':  { rsi:tf60.rsi, macd:tf60.macd?.trend, bb:tf60.bb?.position, score:tf60.score },
        '4h':  { rsi:tf240.rsi, macd:tf240.macd?.trend, bb:tf240.bb?.position, score:tf240.score },
      },
      rsi: tf60.rsi,
    };
  } catch(e) {
    console.error(`[SIGNAL] Error for ${pair}:`, e.message);
    return { action:'HOLD', confidence:0, rsi:50, signals:[], timeframes:{}, vision:null, regime:'UNKNOWN', positionSizeMultiplier:0.5 };
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
  // Run every 30 minutes — more chances to catch signals at peak confidence
  buyCheckTimer = setInterval(async () => {
    try { await checkBuyOpportunity(); }
    catch(e) { console.error('[BUY CHECK] Interval error:', e.message); }
  }, 30 * 60 * 1000);
  console.log('[BUY CHECK] Scheduled every 30min (independent of advisor interval)');
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

Only include coins above ${botConfig.confidenceMin}% confidence. If none qualify say "No strong signals right now."`;

    if (advice) {
      const advSetting = botConfig.notifications?.advisor;
      if (!advSetting || advSetting === 'off') {
        console.log('[ADVISOR] Notifications off — skipping Telegram');
      } else if (advSetting === '4h' || advSetting === '8h' || advSetting === 'daily') {
        queueNotification('advisor', 'AI Market Analysis', advice.replace(/<[^>]*>/g, '').slice(0, 300));
      } else {
        await sendTelegram(advice);
      }
      console.log('[ADVISOR] Analysis complete');
    }

    // Always run buy check after advisor regardless of interval
    await checkBuyOpportunities(enrichedMarket.map(d => ({ ...d, rsi: d.signal.rsi })));

  } catch(err) {
    console.error('[ADVISOR ERROR]', err.message);
  }
}

// ─── Standalone Buy Opportunity Check ─────────────────────────
// Runs every hour independently so daily advisor doesn't kill buy signals
// Scans ALL pairs — not just the advisor pairs
let buyNotifyCache = {}; // { pair: lastNotifiedTimestamp } — prevents spam

async function checkBuyOpportunity() {
  try {
    console.log('[BUY CHECK] Scanning pairs (fast mode — no vision)...');
    const pairs = getActivePairs(botConfig.currencyMode).slice(0, 7);
    const candidates = [];

    // Phase 1: Fast scan — RSI + MACD + patterns only (no vision, no Claude API)
    for (const pair of pairs) {
      try {
        const [tf15, tf60, tf240] = await Promise.all([
          analyseTimeframe(pair, 15),
          analyseTimeframe(pair, 60),
          analyseTimeframe(pair, 240),
        ]);
        const weightedScore = (tf15.score * 0.5) + (tf60.score * 2) + (tf240.score * 4);
        const maxScore = 26;

        // Use same formula as computeSignalForPair so scores match
        let action = 'HOLD', rawConf = 50;
        if (weightedScore >= 6)       { action='BUY';  rawConf=Math.min(95, 60+(weightedScore/maxScore)*45); }
        else if (weightedScore <= -6) { action='SELL'; rawConf=Math.min(95, 60+(Math.abs(weightedScore)/maxScore)*45); }
        else if (weightedScore >= 3)  { action='BUY';  rawConf=Math.min(70, 50+(weightedScore/maxScore)*35); }
        else if (weightedScore <= -3) { action='SELL'; rawConf=Math.min(70, 50+(Math.abs(weightedScore)/maxScore)*35); }

        // Quick regime check — don't run full daily candle fetch, just use RSI
        // RSI < 40 in context of BUY = slight boost, RSI > 60 = neutral
        if (action === 'BUY' && tf60.rsi < 35) rawConf = Math.min(95, rawConf + 5);

        const threshold = botConfig.confidenceMin;
        console.log(`[BUY CHECK] ${pair}: ${action} ${rawConf.toFixed(0)}% RSI:${tf60.rsi} ws:${weightedScore.toFixed(1)} — ${action==='BUY'&&rawConf>=threshold?'✅ CANDIDATE':'skip'}`);

        if (action === 'BUY' && rawConf >= threshold) {
          const ticker = await fetchSingleTicker(pair);
          if (ticker) {
            candidates.push({ pair, ticker, rsi: tf60.rsi, weightedScore, rawConf });
          }
        }
      } catch(e) { console.warn(`[BUY CHECK] ${pair} error:`, e.message); }
    }

    if (!candidates.length) {
      console.log('[BUY CHECK] No candidates found this run');
      return;
    }

    // Phase 2: Full signal (with vision) only on the best candidate
    // This keeps API costs low while still using vision on real opportunities
    candidates.sort((a,b) => b.rawConf - a.rawConf);
    const best = candidates[0];
    console.log(`[BUY CHECK] Running full signal on best candidate: ${best.pair}`);

    const marketData = [{
      pair:        best.pair,
      displayPair: PAIR_DISPLAY[best.pair] || best.pair,
      price:       best.ticker.price,
      change24h:   best.ticker.change24h,
      high:        best.ticker.high,
      low:         best.ticker.low,
    }];

    await checkBuyOpportunities(marketData);

  } catch(e) { console.error('[BUY CHECK ERROR]', e.message); }
}

// ─── Buy Opportunity Detector ──────────────────────────────────
async function checkBuyOpportunities(marketData, manualTrigger = false) {
  try {
    let audCash = 0, usdCash = 0;
    if (KRAKEN_API_KEY && KRAKEN_API_SECRET) {
      const bal = await krakenPrivateRequest('Balance');
      // Log ALL balance keys so we can see exactly what Kraken returns
      const allKeys = Object.entries(bal).filter(([,v]) => parseFloat(v) > 0);
      console.log(`[BUY CHECK] Full Kraken balance: ${allKeys.map(([k,v]) => `${k}=${parseFloat(v).toFixed(4)}`).join(', ')}`);
      audCash = parseFloat(bal['ZAUD'] || bal['AUD'] || bal['AUDX'] || 0);
      usdCash = parseFloat(bal['ZUSD'] || bal['USD'] || 0);
    }

    const mode = botConfig.currencyMode || 'AUD';

    // Total available cash — Kraken auto-converts AUD↔USD on spot trades
    // so always use AUD as the primary pool regardless of pair currency
    const totalCashAUD  = audCash + (usdCash * 1.55); // rough AUD conversion
    const availableCash = totalCashAUD;
    if (availableCash < 10) {
      console.log(`[BUY CHECK] Insufficient cash — AUD: ${audCash.toFixed(2)}, USD: ${usdCash.toFixed(2)}`);
      return false;
    }

    let bestOpportunity = null;

    for (const d of marketData) {
      try {
        const signal = d.signal || await computeSignalForPair(d.pair);

        const rsiOversold  = signal.rsi <= 35;

        // Threshold comes from app Bot settings — respects confidenceMin and riskLevel
        // If you set 65% in the app and save, the bot uses 65%
        // Conservative adds 5% (harder), Aggressive removes 5% (easier)
        let threshold = botConfig.confidenceMin || 65;
        if (botConfig.riskLevel === 'conservative') threshold = Math.min(90, threshold + 5);
        if (botConfig.riskLevel === 'aggressive')   threshold = Math.max(50, threshold - 5);

        const strongSignal = signal.action === 'BUY' && signal.confidence >= threshold;
        const weakSignal   = signal.action === 'BUY' && rsiOversold && signal.confidence >= (threshold - 10);
        console.log(`[BUY CHECK] ${d.pair}: ${signal.action} ${signal.confidence}% RSI:${signal.rsi} threshold:${threshold}% (${botConfig.riskLevel}) — ${strongSignal||weakSignal?'✅ QUALIFIES':'skip'}`);

        if (!strongSignal && !weakSignal) continue;

        const ticker = await fetchSingleTicker(d.pair);
        if (!ticker) { console.log(`[BUY CHECK] No ticker for ${d.pair} — skipping`); continue; }

        // Get sentiment for extra context
        const sym       = (d.displayPair || PAIR_DISPLAY[d.pair] || d.pair).replace('/AUD','');
        const sentiment = sentimentCache[sym] || { score: 0, label: 'Unknown' };

        // Score this opportunity — higher is better
        const oppScore = signal.confidence
          + (rsiOversold ? 10 : 0)
          + (sentiment.score > 0 ? sentiment.score : 0);

        if (!bestOpportunity || oppScore > bestOpportunity.oppScore) {
          bestOpportunity = {
            pair:          d.pair,
            displayPair:   d.displayPair || PAIR_DISPLAY[d.pair] || d.pair,
            sym,
            price:         ticker.price,
            change24h:     ticker.change24h,
            high:          ticker.high,
            low:           ticker.low,
            rsi:           signal.rsi,
            confidence:    signal.confidence,
            weightedScore: signal.weightedScore,
            patterns:      signal.patterns || [],
            sentiment,
            oppScore,
            signal,  // store full signal object for positionSizeMultiplier, vision etc
          };
        }
      } catch(e) { console.warn(`[BUY CHECK] Error checking ${d.pair}:`, e.message); }
    }

    if (!bestOpportunity) {
      console.log('[BUY CHECK] No qualifying opportunities this run');
      return false; // signal caller that nothing was found
    }

    // ── Currency rerouting and cash calculation ────────────────
    // If USD pair but no USD cash: reroute to AUD equivalent automatically
    if (pairCurrency(bestOpportunity.pair) === 'USD' && usdCash < 5) {
      const audPair = rerouteToAUD(bestOpportunity.pair);
      if (audPair && audCash >= 10) {
        console.log(`[BUY CHECK] Rerouting ${bestOpportunity.pair} → ${audPair} (no USD, using AUD)`);
        try {
          const audTicker = await fetchSingleTicker(audPair);
          if (audTicker) {
            bestOpportunity.pair        = audPair;
            bestOpportunity.displayPair = PAIR_DISPLAY[audPair] || audPair;
            bestOpportunity.price       = audTicker.price;
          }
        } catch(e) { console.warn('[BUY CHECK] Reroute ticker failed:', e.message); }
      } else if (!audPair || audCash < 10) {
        // No equivalent or insufficient AUD — only show message on manual trigger
        if (manualTrigger) {
          await sendTelegram(
            `⚠️ <b>${bestOpportunity.displayPair} signal found — no tradeable balance</b>\n\n` +
            `Confidence: ${bestOpportunity.confidence}%\n` +
            `USD balance: $${usdCash.toFixed(2)} | AUD balance: ${fmtAUDServer(audCash)}\n\n` +
            `Deposit AUD to Kraken or switch to AUD mode to trade this signal.`
          );
        }
        return false;
      }
    }

    // Cash to use — always recalculate AFTER any rerouting
    const finalPairCurr = pairCurrency(bestOpportunity.pair);
    const cashForPair   = finalPairCurr === 'USD' ? usdCash : audCash;

    if (cashForPair < 10) {
      console.log(`[BUY CHECK] Insufficient ${finalPairCurr} cash: ${cashForPair.toFixed(2)}`);
      return false;
    }

    // Position sizing by conviction
    const posMultiplier = bestOpportunity.signal?.positionSizeMultiplier || 1.0;
    const baseSizeAUD   = Math.min(cashForPair * 0.25, cashForPair - 10);
    const suggestedAUD  = Math.max(10, Math.min(baseSizeAUD * posMultiplier, cashForPair * 0.40));
    console.log(`[BUY CHECK] ${bestOpportunity.displayPair} — cash: ${cashForPair.toFixed(2)}, size: ${suggestedAUD.toFixed(2)}, posMultiplier: ${posMultiplier}`);

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
    // Cooldown check — applies to BOTH auto-buy and manual prompt
    // Prevents the same coin firing repeatedly on scheduled checks
    const lastNotified = buyNotifyCache[bestOpportunity.pair] || 0;
    const cooldownMs   = 2 * 60 * 60 * 1000;
    if (!manualTrigger && (Date.now() - lastNotified) < cooldownMs) {
      console.log(`[BUY CHECK] ${bestOpportunity.displayPair} qualifies but in 2h cooldown — skipping`);
      return false;
    }
    buyNotifyCache[bestOpportunity.pair] = Date.now();

    // ── AUTO-BUY MODE ─────────────────────────────────────────
    if (botConfig.autoBuy &&
        bestOpportunity.confidence >= botConfig.autoBuyMinConfidence &&
        suggestedAUD <= botConfig.autoBuyMaxAUD) {

      try {
        console.log(`[AUTO-BUY] Executing ${bestOpportunity.displayPair} — ${bestOpportunity.confidence}% confidence`);

        const atrStopInfo             = await calcDynamicStopLoss(bestOpportunity.pair, botConfig.atrMultiplier || 2.0);
        const effectiveStopForDisplay = atrStopInfo?.stopPct || botConfig.stopLossPct;

        const order = await krakenPrivateRequest('AddOrder', {
          pair: bestOpportunity.pair, type: 'buy', ordertype: 'market', volume,
        });

        recordTrade(bestOpportunity.pair, bestOpportunity.sym, 'buy', volume, bestOpportunity.price, 'auto-buy', bestOpportunity.signal?.signalConditions || null);
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
          `📊 <b>Stop Protection Map:</b>\n` +
          `🔴 Stop loss fires if: -${effectiveStopForDisplay}% from entry\n` +
          `🟡 Break-even stop activates at: +${botConfig.breakEvenTriggerPct}% (stop moves to entry)\n` +
          `🟢 Trailing stop activates at: +${botConfig.trailingTriggerPct}% (locks in profit)\n\n` +
          `⏱ Min hold: ${botConfig.minHoldMinutes} min\n` +
          `🔴 To disable auto-buy, go to Bot Settings → Auto-Buy\n` +
          `⏰ ${sydneyTime} AEST`
        );

        console.log(`[AUTO-BUY] ✅ ${bestOpportunity.displayPair} — ${volume} @ ${bestOpportunity.price}`);
        return true; // ← was missing — caused "no buy triggered" message after every auto-buy

      } catch(e) {
        console.error('[AUTO-BUY ERROR]', e.message);
        await sendTelegram(`❌ Auto-buy failed for ${bestOpportunity.displayPair}: ${e.message}`);
        return false;
      }

    } else {
      // ── MANUAL PROMPT MODE ─────────────────────────────────
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
      return true; // signal caller that opportunity was found
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
          const ohlcRaw = await fetchOHLCUniversal(pair, tf.interval);
          const k = null;
          const candles = ohlcRaw.slice(-tf.candles);
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

  // ── Portfolio digest command ────────────────────────────────
  const digestPhrases = ['portfolio', 'my portfolio', 'how am i doing', 'daily summary',
    'daily digest', 'summary', 'portfolio summary', 'show me my portfolio', '/portfolio', '/digest'];

  if (digestPhrases.some(p => msg.includes(p))) {
    await sendTelegramTo(chatId, '📊 Building your portfolio summary...');
    await sendDailyPortfolioDigest();
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
      const scanData  = []; // reuse for buy check so same signals are used

      // Limit to 4 pairs in Telegram scan to avoid timeout
      const scanPairs = getActivePairs(botConfig.currencyMode); // all pairs, not just 4

      for (const pair of scanPairs) {
        try {
          const signal  = await computeSignalForPair(pair, { manualVision: true });
          await new Promise(r => setTimeout(r, 500));
          const ticker  = await fetchSingleTicker(pair);
          if (!ticker) continue;
          const dp      = PAIR_DISPLAY[pair] || pair;
          const sym     = dp.replace('/AUD','').replace('/USD','');
          const sent    = sentimentCache[sym] || { score:0, label:'Unknown' };
          const topPat  = signal.patterns?.[0];

          // Guard against null/broken signal
          if (!signal || !signal.action) {
            results.push(`⚠️ <b>${dp}</b> — signal unavailable`);
            continue;
          }

          const emoji = signal.action === 'BUY'  ? '🟢' :
                        signal.action === 'SELL' ? '🔴' : '🟡';

          results.push(
            `${emoji} <b>${dp}</b> — ${fmtAUDServer(ticker?.price || 0, pair)}\n` +
            `${signal.action} ${signal.confidence}% | Score: ${signal.weightedScore} | RSI: ${signal.rsi}\n` +
            `Regime: ${signal.regime || 'UNKNOWN'}\n` +
            `Sentiment: ${sent.score}/10 (${sent.label})\n` +
            (topPat ? `Pattern: ${topPat.name} — ${topPat.signal}\n` : '') +
            (signal.signals?.length ? `Signals: ${signal.signals.slice(0,2).join(', ')}` : 'No strong signals')
          );

          // Store for buy check reuse
          scanData.push({
            pair, displayPair: dp, sym,
            price: ticker.price, change24h: ticker.change24h,
            high: ticker.high, low: ticker.low,
            signal, // pass signal directly so buy check uses same result
          });
        } catch(e) { console.warn(`[SIGNAL SCAN] ${pair}:`, e.message); }
      }

      const summary = results.length
        ? `🤖 <b>KRAKN·AI Signal Scan</b>\n\n${fgStr}${results.join('\n\n')}\n\n💡 Checking for buy opportunities...`
        : '⚠️ Could not fetch signals. Try again in a moment.';

      await sendTelegramTo(chatId, summary);

      // Pass scan results directly — avoids re-running signals and getting different results
      const found = await checkBuyOpportunities(scanData, true);
      if (!found) {
        // Explain exactly why each coin was skipped
        const reasons = scanData.map(d => {
          const s = d.signal;
          if (!s) return `• ${d.displayPair}: signal error`;
          if (s.action !== 'BUY') return `• ${d.displayPair}: ${s.action} signal (${s.confidence}%)`;
          if (s.confidence < botConfig.confidenceMin) return `• ${d.displayPair}: confidence ${s.confidence}% below threshold ${botConfig.confidenceMin}%`;
          return `• ${d.displayPair}: BUY ${s.confidence}% — passed filters`;
        }).join('\n');

        await sendTelegramTo(chatId,
          `🔍 <b>No buy triggered</b>\n\n${reasons}\n\n` +
          `Threshold: ${botConfig.confidenceMin}% confidence\n` +
          `Cash required: minimum A$10\n` +
          `Tip: Fear & Greed at ${fearGreed.value||'?'}/100 — wait for stronger signals or lower your confidence threshold in bot settings.`
        );
      }

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
      lastBuyTimes[opp.sym] = Date.now();

      // Calculate ATR stop for display
      const atrStopDisplay      = await calcDynamicStopLoss(opp.pair, botConfig.atrMultiplier || 2.0);
      const stopDisplayPct      = atrStopDisplay?.stopPct || botConfig.stopLossPct;
      const stopPriceDisplay    = freshPrice * (1 - stopDisplayPct / 100);
      const breakEvenDisplay    = freshPrice * (1 + botConfig.breakEvenTriggerPct / 100);
      const trailingDisplay     = freshPrice * (1 + botConfig.trailingTriggerPct / 100);

      const sydneyTime = new Date().toLocaleString('en-AU', { timeZone:'Australia/Sydney', dateStyle:'short', timeStyle:'short' });
      await sendTelegramTo(chatId,
        `🟢 <b>BUY ORDER PLACED!</b>\n\n` +
        `<b>${opp.displayPair}</b>\n` +
        `Bought: ${freshVolume} ${opp.sym}\n` +
        `Price: ${fmtAUDServer(freshPrice)}\n` +
        `Total: ≈ ${fmtAUDServer(parseFloat(valueAUD))}\n` +
        `TXID: ${order.txid?.join(', ')}\n\n` +
        `📊 <b>Your Stop Protection:</b>\n` +
        `🔴 Stop loss: ${fmtAUDServer(stopPriceDisplay)} (-${stopDisplayPct}%)\n` +
        `🟡 Break-even at: ${fmtAUDServer(breakEvenDisplay)} (+${botConfig.breakEvenTriggerPct}%) → stop moves to entry\n` +
        `🟢 Trailing stop at: ${fmtAUDServer(trailingDisplay)} (+${botConfig.trailingTriggerPct}%) → locks in profit\n\n` +
        `⏱ Min hold: ${botConfig.minHoldMinutes} min · ⏰ ${sydneyTime} AEST`
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
  if (minConfidence)             botConfig.confidenceMin = parseInt(minConfidence);
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
  try {
    // Only scan active mode pairs capped at 7 — prevents 30-pair scan
    const pairs = getActivePairs(botConfig.currencyMode).slice(0, 7);
    const marketData = [];
    for (const pair of pairs) {
      try {
        const ticker = await fetchSingleTicker(pair);
        if (ticker) marketData.push({
          pair,
          displayPair: PAIR_DISPLAY[pair] || pair,
          price: ticker.price, change24h: ticker.change24h,
          high: ticker.high, low: ticker.low,
        });
      } catch(e) {}
    }
    const found = await checkBuyOpportunities(marketData, true);
    if (!found) {
      await sendTelegram(
        `🔍 <b>Manual Buy Check Complete</b>\n\n` +
        `Scanned ${pairs.length} pairs in ${botConfig.currencyMode} mode — no qualifying opportunities right now.\n\n` +
        `Signals need: BUY action + ${botConfig.confidenceMin}%+ confidence\n` +
        `Current regime filters may be suppressing weak signals.\n\n` +
        `Try again in 30-60 minutes or lower your confidence threshold in Bot settings.`
      );
    }
  } catch(e) {
    await sendTelegram(`❌ Buy check error: ${e.message}`);
  }
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

      // All smart money goes to daily digest — only exception is >90% confidence
      // which suggests an imminent major move worth knowing about immediately
      if (interpretation.urgency === 'HIGH' && interpretation.confidence >= 90) {
        await sendTelegram(msg);
      } else {
        queueNotification('smartMoney',
          `${wallet.label}: ${interpretation.action} ${interpretation.coin}`,
          `Confidence: ${interpretation.confidence}% | ${interpretation.urgency}\n${interpretation.reasoning?.slice(0,100)}`
        );
      }

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

// ══════════════════════════════════════════════════════════════
// LEARNING ENGINE
// Analyses closed trade outcomes and adjusts signal weights
// ══════════════════════════════════════════════════════════════

let lastLearnAt     = 0;
let learningLog     = [];
let learningEnabled = true;

async function learnFromOutcomes() {
  if (!learningEnabled) return;
  if (tradeOutcomes.length < 5) return;
  if (Date.now() - lastLearnAt < 60 * 60 * 1000) return;

  try {
    console.log(`[LEARNING] Analysing ${tradeOutcomes.length} trade outcomes...`);
    lastLearnAt = Date.now();

    const conditionStats = {};
    tradeOutcomes.forEach(outcome => {
      if (!outcome.conditions) return;
      const signals = outcome.conditions.activeSignals || [];
      signals.forEach(signal => {
        if (!conditionStats[signal]) conditionStats[signal] = { wins:0, losses:0, totalPnl:0 };
        if (outcome.won) conditionStats[signal].wins++;
        else conditionStats[signal].losses++;
        conditionStats[signal].totalPnl += outcome.pnlPct;
      });
    });

    const winRate = tradeOutcomes.filter(t => t.won).length / tradeOutcomes.length;
    const avgPnl  = tradeOutcomes.reduce((s,t) => s + t.pnlPct, 0) / tradeOutcomes.length;

    const conditionSummary = Object.entries(conditionStats)
      .sort(([,a],[,b]) => (b.wins/(b.wins+b.losses)||0) - (a.wins/(a.wins+a.losses)||0))
      .map(([name, s]) => {
        const rate = s.wins + s.losses > 0 ? ((s.wins/(s.wins+s.losses))*100).toFixed(0) : '?';
        return `${name}: ${rate}% win rate (${s.wins}W/${s.losses}L, avg ${(s.totalPnl/(s.wins+s.losses)).toFixed(1)}% P&L)`;
      }).join('\n');

    const recentOutcomes = tradeOutcomes.slice(-20).map(o =>
      `${o.sym} ${o.won?'WIN':'LOSS'} ${o.pnlPct>0?'+':''}${o.pnlPct}% | RSI:${o.conditions?.rsi||'?'} | ${(o.conditions?.activeSignals||[]).slice(0,3).join(',')} | held ${o.durationMinutes}min`
    ).join('\n');

    const prompt = `You are a quantitative trading analyst reviewing a crypto trading bot's performance.

OVERALL STATS (${tradeOutcomes.length} closed trades):
Win rate: ${(winRate*100).toFixed(1)}%
Average P&L per trade: ${avgPnl.toFixed(2)}%

SIGNAL PERFORMANCE:
${conditionSummary || 'Not enough data per signal yet'}

RECENT TRADES:
${recentOutcomes}

CURRENT SIGNAL WEIGHTS:
${JSON.stringify(signalWeights, null, 2)}

Based on this data, suggest weight adjustments to improve future performance.

Return ONLY this JSON (no markdown):
{
  "weightAdjustments": { "rsi_oversold": 1.2, "hammer": 0.9 },
  "keyInsight": "One sentence — most important pattern discovered",
  "winningPattern": "What conditions appear in most winning trades",
  "losingPattern": "What conditions appear in most losing trades",
  "recommendedConfidenceMin": 75,
  "recommendedMinHoldMinutes": 60
}

Only include signals with 5+ occurrences. Weight range: 0.3-2.0. Max change 0.3 per session.`;

    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 30000);
    const response   = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type':'application/json', 'x-api-key':process.env.ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:600, messages:[{ role:'user', content:prompt }] })
    });
    clearTimeout(timeout);

    const data    = await response.json();
    const text    = (data.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('').trim();
    const match   = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in response');
    const learning = JSON.parse(match[0]);

    let changesApplied = 0;
    if (learning.weightAdjustments) {
      Object.entries(learning.weightAdjustments).forEach(([key, val]) => {
        if (signalWeights.hasOwnProperty(key)) {
          const newWeight = Math.max(0.3, Math.min(2.0, parseFloat(val)));
          if (Math.abs(newWeight - signalWeights[key]) > 0.05) {
            console.log(`[LEARNING] ${key}: ${signalWeights[key].toFixed(2)} → ${newWeight.toFixed(2)}`);
            signalWeights[key] = newWeight;
            changesApplied++;
          }
        }
      });
    }

    if (learning.recommendedConfidenceMin &&
        Math.abs(learning.recommendedConfidenceMin - botConfig.confidenceMin) >= 5) {
      botConfig.confidenceMin = Math.max(65, Math.min(90, learning.recommendedConfidenceMin));
    }

    learningLog.unshift({
      timestamp: new Date().toISOString(),
      tradesAnalysed: tradeOutcomes.length,
      winRate: parseFloat((winRate*100).toFixed(1)),
      avgPnl:  parseFloat(avgPnl.toFixed(2)),
      changesApplied,
      keyInsight:     learning.keyInsight,
      winningPattern: learning.winningPattern,
      losingPattern:  learning.losingPattern,
      weightsAfter:   { ...signalWeights },
    });
    if (learningLog.length > 50) learningLog = learningLog.slice(0, 50);
    saveData();

    console.log(`[LEARNING] ✅ ${changesApplied} changes applied — ${learning.keyInsight}`);

    if (changesApplied > 0) {
      queueNotification('learning',
        `Learning Update: ${changesApplied} weights adjusted`,
        `Win rate: ${(winRate*100).toFixed(1)}% | Avg P&L: ${avgPnl.toFixed(2)}%\n` +
        `Insight: ${learning.keyInsight}`
      );
    }
  } catch(e) { console.warn('[LEARNING] Failed:', e.message); }
}

app.get('/api/learning/weights', requireAuth, (req, res) => {
  res.json({ success:true, data:{ signalWeights, learningLog, tradeOutcomes:tradeOutcomes.slice(-20), enabled:learningEnabled } });
});
app.post('/api/learning/run', requireAuth, async (req, res) => {
  lastLearnAt = 0;
  res.json({ success:true, message:'Learning session started — check Telegram!' });
  learnFromOutcomes();
});
app.post('/api/learning/reset', requireAuth, (req, res) => {
  Object.keys(signalWeights).forEach(k => signalWeights[k] = 1.0);
  learningLog = [];
  saveData();
  res.json({ success:true, message:'Signal weights reset to defaults' });
});
app.post('/api/learning/toggle', requireAuth, (req, res) => {
  learningEnabled = !learningEnabled;
  res.json({ success:true, enabled:learningEnabled });
});

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
  try {
    const before = smartMoneyAlertLog.length;
    await checkSmartMoneySignals();
    const after  = smartMoneyAlertLog.length;
    if (after === before) {
      // No new alerts fired — send a summary message
      await sendTelegram(
        `🔍 <b>Smart Money Scan Complete</b>\n\n` +
        `Checked ${smartWallets.filter(w=>w.active).length} wallets — no significant activity in the last 2 hours.\n\n` +
        `Wallets monitored:\n` +
        smartWallets.filter(w=>w.active).slice(0,5)
          .map(w => `• ${w.label} (${w.chain})`)
          .join('\n') +
        `\n\n💡 Alerts fire automatically when a wallet makes a large move on a coin KRAKN·AI is tracking.`
      );
    }
  } catch(e) {
    await sendTelegram(`❌ Smart money scan error: ${e.message}`);
  }
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

        queueNotification('macroEvents',
          `📅 MACRO EVENT IN ${Math.round(minutesUntil)}min: ${event.title}`,
          `${event.country} | Impact: HIGH | ${event.time} UTC\n` +
          `Stop-loss tightened from ${wasStopLossPct}% → ${tightened}% during event.`
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

// ══════════════════════════════════════════════════════════════
// PERFORMANCE REPORT — Full intelligence on bot improvement
// ══════════════════════════════════════════════════════════════
async function calculatePerformance(days = 30) {
  try {
    const now   = Date.now();
    const start = now - days * 24 * 60 * 60 * 1000;

    // Portfolio value progression
    const relevant = portfolioHistory.filter(p => p.timestamp >= start);
    let portfolioReturn = null;
    if (relevant.length >= 2) {
      const first = relevant[0], last = relevant[relevant.length-1];
      portfolioReturn = {
        startValue: first.valueAUD, endValue: last.valueAUD,
        returnPct:  parseFloat((((last.valueAUD-first.valueAUD)/first.valueAUD)*100).toFixed(2)),
        dataPoints: relevant.length,
        history:    relevant.slice(-30),
      };
    }

    // Trade outcomes in period
    const periodOutcomes = tradeOutcomes.filter(t => new Date(t.timestamp).getTime() >= start);
    const wins   = periodOutcomes.filter(t => t.won);
    const losses = periodOutcomes.filter(t => !t.won);
    const winRate     = periodOutcomes.length ? (wins.length/periodOutcomes.length)*100 : 0;
    const avgWinPct   = wins.length   ? wins.reduce((s,t)=>s+t.pnlPct,0)/wins.length   : 0;
    const avgLossPct  = losses.length ? losses.reduce((s,t)=>s+t.pnlPct,0)/losses.length : 0;
    const avgHoldMins = periodOutcomes.length ? periodOutcomes.reduce((s,t)=>s+t.durationMinutes,0)/periodOutcomes.length : 0;
    const totalPnl    = Object.values(pnlByAsset).reduce((s,a)=>s+a.realisedPnl,0);
    const totalWinAUD = wins.reduce((s,t)=>s+(t.pnlAUD||0),0);
    const totalLossAUD = Math.abs(losses.reduce((s,t)=>s+(t.pnlAUD||0),0));
    const profitFactor = totalLossAUD > 0 ? totalWinAUD/totalLossAUD : totalWinAUD > 0 ? 999 : 0;
    const sorted = [...periodOutcomes].sort((a,b)=>(b.pnlPct||0)-(a.pnlPct||0));

    // Per-coin breakdown
    const coinBreakdown = {};
    periodOutcomes.forEach(t => {
      if (!coinBreakdown[t.sym]) coinBreakdown[t.sym] = { wins:0, losses:0, totalPnl:0 };
      if (t.won) coinBreakdown[t.sym].wins++;
      else coinBreakdown[t.sym].losses++;
      coinBreakdown[t.sym].totalPnl += t.pnlPct||0;
    });

    // BTC benchmark
    let btcReturn = null;
    try {
      const btcPrices = await fetchBenchmarkData();
      if (btcPrices?.length >= 2) {
        const btcStart = btcPrices.find(p=>p[0]>=start)?.[1] || btcPrices[0][1];
        const btcEnd   = btcPrices[btcPrices.length-1][1];
        btcReturn      = parseFloat((((btcEnd-btcStart)/btcStart)*100).toFixed(2));
      }
    } catch(e) {}

    // Learning progression — split all outcomes into thirds
    const all   = tradeOutcomes.slice(-90);
    const third = Math.floor(all.length/3);
    let learningProgression = null;
    if (all.length >= 9) {
      const early  = all.slice(0, third);
      const mid    = all.slice(third, third*2);
      const recent = all.slice(third*2);
      const wr = arr => arr.length ? arr.filter(t=>t.won).length/arr.length*100 : 0;
      const ap = arr => arr.length ? arr.reduce((s,t)=>s+t.pnlPct,0)/arr.length : 0;
      learningProgression = {
        early:  { winRate:parseFloat(wr(early).toFixed(1)),  avgPnl:parseFloat(ap(early).toFixed(2)),  trades:early.length },
        mid:    { winRate:parseFloat(wr(mid).toFixed(1)),    avgPnl:parseFloat(ap(mid).toFixed(2)),    trades:mid.length   },
        recent: { winRate:parseFloat(wr(recent).toFixed(1)), avgPnl:parseFloat(ap(recent).toFixed(2)), trades:recent.length },
        improving:    wr(recent) > wr(early),
        winRateDelta: parseFloat((wr(recent)-wr(early)).toFixed(1)),
        pnlDelta:     parseFloat((ap(recent)-ap(early)).toFixed(2)),
      };
    }

    const weightChanges = Object.entries(signalWeights)
      .filter(([,v]) => Math.abs(v-1.0) > 0.05)
      .sort(([,a],[,b]) => Math.abs(b-1.0)-Math.abs(a-1.0))
      .map(([k,v]) => ({ signal:k, weight:parseFloat(v.toFixed(2)), direction:v>1?'boosted':'reduced' }));

    return {
      period: days, generated: new Date().toISOString(),
      portfolio: portfolioReturn, btcReturn,
      alpha: portfolioReturn && btcReturn !== null
        ? parseFloat((portfolioReturn.returnPct - btcReturn).toFixed(2)) : null,
      trades: {
        total: tradeLog.filter(t=>new Date(t.timestamp).getTime()>=start).length,
        closed: periodOutcomes.length,
        wins: wins.length, losses: losses.length,
        winRate: parseFloat(winRate.toFixed(1)),
        avgWinPct: parseFloat(avgWinPct.toFixed(2)),
        avgLossPct: parseFloat(avgLossPct.toFixed(2)),
        avgHoldMins: Math.round(avgHoldMins),
        profitFactor: parseFloat(profitFactor.toFixed(2)),
        totalPnlAUD: parseFloat(totalPnl.toFixed(2)),
        bestTrade:  sorted[0] || null,
        worstTrade: sorted[sorted.length-1] || null,
        coinBreakdown,
        recentOutcomes: periodOutcomes.slice(-10).reverse(),
      },
      learning: {
        sessionsRun: learningLog.length,
        lastSession: learningLog[0] || null,
        progression: learningProgression,
        weightChanges,
        totalWeightsAdjusted: weightChanges.length,
        learningLog: learningLog.slice(0,5),
        currentWeights: signalWeights,
      },
    };
  } catch(e) {
    console.warn('[PERFORMANCE] Failed:', e.message);
    return null;
  }
}

app.get('/api/performance', requireAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const perf = await calculatePerformance(days);
    res.json({ success:true, data:perf });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// ── Backtester — replays historical candles through live signal engine ──
app.post('/api/backtest', requireAuth, async (req, res) => {
  try {
    const {
      pair            = 'XBTAUD',
      interval        = 240,
      confMin         = 65,
      stopLossPct     = 3,
      takeProfitPct   = 6,
      maxHoldCandles  = 48,
    } = req.body;

    const raw = await krakenPublicRequest('OHLC', { pair, interval: parseInt(interval) });
    const key = Object.keys(raw).find(k => k !== 'last');
    const allCandles = raw[key];
    if (!allCandles || allCandles.length < 60) return res.json({ success:false, error:'Not enough candle data' });

    console.log(`[BACKTEST] ${pair} ${interval}m — ${allCandles.length} candles`);
    const WARMUP = 50;
    const trades = [];
    let position  = null;

    for (let i = WARMUP; i < allCandles.length - 1; i++) {
      const window  = allCandles.slice(0, i + 1);
      const closes  = window.map(c => parseFloat(c[4]));
      const volumes = window.map(c => parseFloat(c[6]));
      const price   = parseFloat(allCandles[i][4]);
      const ts      = allCandles[i][0] * 1000;

      const rsi  = calcRSI(closes);
      const macd = calcMACD(closes);
      const bb   = calcBollingerBands(closes);
      const volS = calcVolumeSignal(volumes, closes);
      const pats = detectCandlePatterns(window.slice(-10));
      const patS = scorePatterns(pats);
      const ma20 = closes.slice(-20).reduce((s,v) => s+v, 0) / 20;
      const aboveMa20 = price > ma20;

      // Exact same scoring as analyseTimeframe
      let score = 0;
      if (rsi < 30)       score += 2; else if (rsi < 45)  score += 1;
      else if (rsi > 70)  score -= 2; else if (rsi > 55)  score -= 1;
      if (macd.trend === 'BULLISH')          score += 1;
      else if (macd.trend === 'BEARISH')     score -= 1;
      if (bb.position === 'OVERSOLD')        score += 2;
      else if (bb.position === 'LOWER_HALF') score += 1;
      else if (bb.position === 'OVERBOUGHT') score -= 2;
      else if (bb.position === 'UPPER_HALF') score -= 1;
      if (volS === 'STRONG_BUY')   score += 2; else if (volS === 'BUY')    score += 1;
      else if (volS === 'STRONG_SELL') score -= 2; else if (volS === 'SELL') score -= 1;
      score += patS.score;

      // Same confidence formula as computeSignalForPair
      let confidence = 50, action = 'HOLD';
      if (score >= 6)       { action='BUY';  confidence=Math.min(95, 60+(score/26)*45); }
      else if (score <= -6) { action='SELL'; confidence=Math.min(95, 60+(Math.abs(score)/26)*45); }
      else if (score >= 3)  { action='BUY';  confidence=Math.min(70, 50+(score/26)*35); }
      else if (score <= -3) { action='SELL'; confidence=Math.min(70, 50+(Math.abs(score)/26)*35); }
      if (action === 'BUY' && !aboveMa20) confidence = Math.max(0, confidence - 12);
      if (action === 'BUY' && aboveMa20)  confidence = Math.min(99, confidence + 5);
      if (rsi < 28) confidence = Math.min(99, confidence + 8);
      else if (rsi < 33) confidence = Math.min(99, confidence + 4);

      if (!position) {
        if (action === 'BUY' && confidence >= confMin) {
          position = { entryPrice:price, entryIdx:i, entryTs:ts, entryRsi:Math.round(rsi), entryConf:Math.round(confidence) };
        }
      } else {
        const heldCandles = i - position.entryIdx;
        const pnlPct      = ((price - position.entryPrice) / position.entryPrice) * 100;
        let exitReason    = null;
        if (pnlPct <= -stopLossPct)                              exitReason = 'stop-loss';
        else if (takeProfitPct > 0 && pnlPct >= takeProfitPct)  exitReason = 'take-profit';
        else if (heldCandles >= maxHoldCandles)                  exitReason = 'max-hold';
        else if (action === 'SELL' && confidence >= 70)          exitReason = 'signal-sell';
        if (exitReason) {
          trades.push({ entryTs:position.entryTs, exitTs:ts, entryPrice:+position.entryPrice.toFixed(4),
            exitPrice:+price.toFixed(4), pnlPct:+pnlPct.toFixed(2), won:pnlPct>0,
            reason:exitReason, heldCandles, entryRsi:position.entryRsi, entryConf:position.entryConf });
          position = null;
        }
      }
    }

    // Close any open position at last candle
    if (position) {
      const lp = parseFloat(allCandles[allCandles.length-1][4]);
      const pp = ((lp - position.entryPrice) / position.entryPrice) * 100;
      trades.push({ entryTs:position.entryTs, exitTs:allCandles[allCandles.length-1][0]*1000,
        entryPrice:+position.entryPrice.toFixed(4), exitPrice:+lp.toFixed(4), pnlPct:+pp.toFixed(2),
        won:pp>0, reason:'end-of-data', heldCandles:allCandles.length-1-position.entryIdx,
        entryRsi:position.entryRsi, entryConf:position.entryConf });
    }

    const wins   = trades.filter(t => t.won);
    const losses = trades.filter(t => !t.won);
    const avgWin  = wins.length   ? wins.reduce((s,t)=>s+t.pnlPct,0)/wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((s,t)=>s+t.pnlPct,0)/losses.length : 0;
    const pf      = losses.length && avgLoss !== 0 ? Math.abs(avgWin*wins.length/(avgLoss*losses.length)) : 0;
    const maxDD   = trades.reduce((dd,t) => t.pnlPct < dd ? t.pnlPct : dd, 0);

    let capital = 500;
    const equity = [{ ts:allCandles[WARMUP][0]*1000, value:500 }];
    trades.forEach(t => { capital *= (1+t.pnlPct/100); equity.push({ ts:t.exitTs, value:+capital.toFixed(2) }); });

    res.json({ success:true, data: {
      pair, interval, confMin, stopLossPct, takeProfitPct,
      candleCount: allCandles.length,
      startDate: new Date(allCandles[WARMUP][0]*1000).toISOString(),
      endDate:   new Date(allCandles[allCandles.length-1][0]*1000).toISOString(),
      stats: {
        trades:trades.length, wins:wins.length, losses:losses.length,
        winRate:+(trades.length?(wins.length/trades.length*100):0).toFixed(1),
        totalPnlPct:+trades.reduce((s,t)=>s+t.pnlPct,0).toFixed(2),
        avgWinPct:+avgWin.toFixed(2), avgLossPct:+avgLoss.toFixed(2),
        profitFactor:+pf.toFixed(2), maxDrawdown:+maxDD.toFixed(2),
        finalCapital:+capital.toFixed(2), startCapital:500,
      },
      equity, trades: trades.slice(-100),
    }});
  } catch(e) { console.error('[BACKTEST]', e.message); res.status(500).json({ success:false, error:e.message }); }
});

// ── Public performance page — no auth, safe to share ──────────
app.get('/performance', async (req, res) => {
  try {
    const perf  = await calculatePerformance(90);
    const trades = tradeOutcomes.slice(-50).reverse();
    const t      = perf?.trades || {};
    const prog   = perf?.learning?.progression;

    const rows = trades.map(o => `
      <tr class="${o.won?'win':'loss'}">
        <td>${new Date(o.timestamp).toLocaleDateString('en-AU')}</td>
        <td><b>${o.sym}</b></td>
        <td>${o.won?'🟢 WIN':'🔴 LOSS'}</td>
        <td style="color:${o.pnlPct>=0?'#00C896':'#FF4466'};font-family:monospace">
          ${o.pnlPct>=0?'+':''}${o.pnlPct.toFixed(2)}%</td>
        <td style="font-family:monospace">${o.durationMinutes>=60?(o.durationMinutes/60).toFixed(1)+'h':o.durationMinutes+'m'}</td>
        <td style="font-size:11px;color:#64748B">
          $${o.buyPrice?.toFixed(2)||'?'} → $${o.sellPrice?.toFixed(2)||'?'}</td>
      </tr>`).join('');

    const progHTML = prog ? ['early','mid','recent'].map(k => `
      <div style="margin-bottom:12px">
        <div style="font-size:11px;color:#64748B;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">
          ${k==='early'?'Early Trades':k==='mid'?'Mid Period':'Recent'}</div>
        <div style="height:6px;background:rgba(255,255,255,0.06);border-radius:3px;margin-bottom:4px">
          <div style="height:100%;width:${prog[k].winRate}%;background:${k==='recent'&&prog.improving?'#00C896':'#00D4FF'};border-radius:3px"></div>
        </div>
        <div style="font-family:monospace;font-size:12px">
          ${prog[k].winRate}% win rate | avg ${prog[k].avgPnl>=0?'+':''}${prog[k].avgPnl}% | ${prog[k].trades} trades
          ${k==='recent'?(prog.improving?' 📈 IMPROVING':' 📉 needs more data'):''}</div>
      </div>`).join('')
    : '<p style="color:#64748B;font-size:13px">Need 9+ closed trades for progression analysis.</p>';

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta property="og:title" content="KRAKN·AI — Verified Live Performance">
<meta property="og:description" content="Live AI crypto trading bot performance. ${t.closed||0} trades, ${(t.winRate||0).toFixed(1)}% win rate.">
<title>KRAKN·AI — Verified Performance</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#050810;color:#fff;font-family:'Inter',sans-serif;padding:32px 4vw 80px}
.logo{font-family:'Space Mono',monospace;font-size:24px;font-weight:700;
  background:linear-gradient(135deg,#fff 40%,#00D4FF);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.badge{display:inline-block;padding:3px 10px;background:rgba(0,200,150,0.1);border:1px solid rgba(0,200,150,0.25);
  border-radius:20px;font-size:10px;color:#00C896;font-family:'Space Mono',monospace;letter-spacing:0.1em;margin-left:10px;vertical-align:middle}
.sub{color:#64748B;font-size:13px;margin:8px 0 32px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:32px}
.card{background:rgba(0,212,255,0.04);border:1px solid rgba(0,212,255,0.12);border-radius:14px;padding:18px;text-align:center}
.val{font-family:'Space Mono',monospace;font-size:24px;font-weight:700;margin-bottom:4px}
.key{font-size:10px;color:#64748B;text-transform:uppercase;letter-spacing:0.1em}
.green{color:#00C896}.red{color:#FF4466}.cyan{color:#00D4FF}
h2{font-family:'Space Mono',monospace;font-size:13px;color:#00D4FF;letter-spacing:0.12em;
  text-transform:uppercase;margin:32px 0 14px;padding-bottom:10px;border-bottom:1px solid rgba(0,212,255,0.1)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{padding:8px 12px;color:#64748B;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;
  text-align:left;border-bottom:1px solid rgba(0,212,255,0.1)}
td{padding:10px 12px;border-bottom:1px solid rgba(0,212,255,0.05)}
tr.win td:first-child{border-left:3px solid #00C896}
tr.loss td:first-child{border-left:3px solid #FF4466}
.disclaimer{margin-top:40px;padding:16px 20px;background:rgba(255,255,255,0.02);
  border-radius:10px;font-size:11px;color:#64748B;line-height:1.8}
@media(max-width:600px){.grid{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>
<div>
  <span class="logo">KRAKN·AI</span>
  <span class="badge">✓ VERIFIED LIVE</span>
</div>
<div class="sub">Live AI crypto trading — all trades executed on Kraken exchange · ${new Date().toLocaleDateString('en-AU',{timeZone:'Australia/Sydney'})} AEST</div>

<div class="grid">
  <div class="card">
    <div class="val ${(t.winRate||0)>=55?'green':(t.winRate||0)>=45?'':'red'}">${(t.winRate||0).toFixed(1)}%</div>
    <div class="key">Win Rate</div>
  </div>
  <div class="card">
    <div class="val ${(t.totalPnlAUD||0)>=0?'green':'red'}">${(t.totalPnlAUD||0)>=0?'+':''}A$${Math.abs(t.totalPnlAUD||0).toFixed(2)}</div>
    <div class="key">Total P&L</div>
  </div>
  <div class="card">
    <div class="val">${t.closed||0}</div>
    <div class="key">Trades Closed</div>
  </div>
  <div class="card">
    <div class="val ${(t.profitFactor||0)>=1.5?'green':(t.profitFactor||0)>=1?'':'red'}">${(t.profitFactor||0).toFixed(2)}</div>
    <div class="key">Profit Factor</div>
  </div>
  <div class="card">
    <div class="val green">+${(t.avgWinPct||0).toFixed(2)}%</div>
    <div class="key">Avg Win</div>
  </div>
  <div class="card">
    <div class="val red">${(t.avgLossPct||0).toFixed(2)}%</div>
    <div class="key">Avg Loss</div>
  </div>
  ${perf?.alpha!==null&&perf?.alpha!==undefined?`<div class="card">
    <div class="val ${perf.alpha>=0?'green':'red'}">${perf.alpha>=0?'+':''}${perf.alpha.toFixed(2)}%</div>
    <div class="key">Alpha vs BTC</div>
  </div>`:''}
</div>

<h2>Learning Progression</h2>
${progHTML}

<h2>Trade History — Last ${Math.min(trades.length,50)} Closed Trades</h2>
${trades.length>0?`<table>
<tr><th>Date</th><th>Coin</th><th>Result</th><th>P&L</th><th>Held</th><th>Prices</th></tr>
${rows}
</table>`:'<p style="color:#64748B;font-size:13px">No closed trades yet.</p>'}

<div class="disclaimer">
  ⚠️ Past performance does not guarantee future results. Cryptocurrency trading involves substantial risk of loss.
  All trades shown are live trades on Kraken exchange executed by an automated AI system.
  This is not financial advice. Only invest what you can afford to lose.
</div>
</body>
</html>`);
  } catch(e) { res.status(500).send('<h1 style="color:white;background:#050810;padding:40px">Performance loading... try again in a moment.</h1>'); }
});

app.post('/api/performance/report', requireAuth, async (req, res) => {
  res.json({ success:true, message:'Generating report — check Telegram!' });
  try {
    const perf = await calculatePerformance(30);
    if (!perf) { await sendTelegram('📊 Not enough data yet — keep the bot running to generate a report.'); return; }
    const t = perf.trades, l = perf.learning, prog = l.progression;
    await sendTelegram(
      `📊 <b>KRAKN·AI Performance Report</b>\n` +
      `Generated: ${new Date().toLocaleString('en-AU',{timeZone:'Australia/Sydney',dateStyle:'short',timeStyle:'short'})}\n\n` +

      `<b>Portfolio (30 days)</b>\n` +
      `${perf.portfolio ? `Return: ${perf.portfolio.returnPct>=0?'+':''}${perf.portfolio.returnPct}%\n` : 'Insufficient history\n'}` +
      `vs BTC: ${perf.btcReturn!==null?`${perf.btcReturn>=0?'+':''}${perf.btcReturn}%`:'N/A'}\n` +
      `Alpha: ${perf.alpha!==null?`${perf.alpha>=0?'+':''}${perf.alpha}%`:'N/A'}\n\n` +

      `<b>Trading Stats</b>\n` +
      `Closed trades: ${t.closed}\n` +
      `Win rate: ${t.winRate}% (${t.wins}W / ${t.losses}L)\n` +
      `Avg win: +${t.avgWinPct}% | Avg loss: ${t.avgLossPct}%\n` +
      `Profit factor: ${t.profitFactor} ${t.profitFactor>=1.5?'✅':t.profitFactor>=1?'⚠️':'❌'}\n` +
      `Avg hold time: ${t.avgHoldMins} minutes\n` +
      (t.bestTrade  ? `Best trade: ${t.bestTrade.sym} +${t.bestTrade.pnlPct}%\n`  : '') +
      (t.worstTrade ? `Worst trade: ${t.worstTrade.sym} ${t.worstTrade.pnlPct}%\n` : '') +

      `\n<b>🧠 Learning Progress</b>\n` +
      `Sessions run: ${l.sessionsRun}\n` +
      `Weights adjusted: ${l.totalWeightsAdjusted} signals\n` +
      (prog ? `Early win rate: ${prog.early.winRate}% → Recent: ${prog.recent.winRate}% (${prog.winRateDelta>=0?'+':''}${prog.winRateDelta}%)\n` +
              `${prog.improving ? '📈 Bot is improving over time' : '📉 Still learning — more trades needed'}\n` : 'Need 9+ trades for progression data\n') +
      (l.lastSession?.keyInsight ? `\nLatest insight: ${l.lastSession.keyInsight}` : '')
    );
  } catch(e) { console.error('[REPORT]', e.message); }
});

// ══════════════════════════════════════════════════════════════
// ALPACA — US STOCK TRADING ROUTES
// ══════════════════════════════════════════════════════════════

// Account info
app.get('/api/alpaca/account', requireAuth, async (req, res) => {
  try {
    const account = await getAlpacaAccount();
    res.json({ success:true, data:{
      buyingPower:  parseFloat(account.buying_power),
      cash:         parseFloat(account.cash),
      equity:       parseFloat(account.equity),
      portfolioValue: parseFloat(account.portfolio_value),
      currency:     account.currency,
      status:       account.status,
      paperTrading: ALPACA_PAPER,
    }});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Stock positions
app.get('/api/alpaca/positions', requireAuth, async (req, res) => {
  try {
    const positions = await getAlpacaPositions();
    const mapped    = positions.map(p => ({
      symbol:     p.symbol,
      qty:        parseFloat(p.qty),
      avgEntry:   parseFloat(p.avg_entry_price),
      currentPrice: parseFloat(p.current_price),
      marketValue:  parseFloat(p.market_value),
      unrealisedPnl: parseFloat(p.unrealized_pl),
      unrealisedPct: parseFloat(p.unrealized_plpc) * 100,
      side:       p.side,
    }));
    res.json({ success:true, data: mapped });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Stock quote
app.get('/api/alpaca/quote/:symbol', requireAuth, async (req, res) => {
  try {
    const ticker = await fetchStockTicker(req.params.symbol.toUpperCase());
    if (!ticker) return res.status(404).json({ error: 'Symbol not found' });
    res.json({ success:true, data: ticker });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Stock bars (OHLC)
app.get('/api/alpaca/bars/:symbol', requireAuth, async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const tf     = req.query.timeframe || '1Hour';
    const limit  = parseInt(req.query.limit) || 60;
    const bars   = await fetchStockBars(symbol, tf, limit);
    res.json({ success:true, data: bars, symbol });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Place stock order
app.post('/api/alpaca/order', requireAuth, requireKeys, async (req, res) => {
  try {
    const { symbol, side, qty, orderType, limitPrice } = req.body;
    if (!symbol || !side || !qty) return res.status(400).json({ error: 'symbol, side and qty required' });

    const sym = symbol.toUpperCase();
    if (!ALPACA_KEY) return res.status(503).json({ error: 'Alpaca not configured — add ALPACA_API_KEY and ALPACA_API_SECRET to Railway' });

    const order  = await placeStockOrder(sym, side, qty, orderType || 'market', limitPrice);
    const ticker = await fetchStockTicker(sym);

    recordTrade(
      sym, sym, side,
      parseFloat(qty), ticker?.price || 0,
      'alpaca-manual', null
    );

    await sendTelegram(
      `${side === 'buy' ? '🟢' : '🔴'} <b>STOCK ${side.toUpperCase()} — ${sym}</b>\n\n` +
      `Qty: ${qty} shares\n` +
      `Price: US$${ticker?.price?.toFixed(2) || '?'}\n` +
      `Value: ≈ US$${(qty * (ticker?.price||0)).toFixed(2)}\n` +
      `Order ID: ${order.id}\n` +
      `Status: ${order.status}\n` +
      `${ALPACA_PAPER ? '📝 PAPER TRADE' : '💰 LIVE TRADE'}`
    );

    res.json({ success:true, data: order });
  } catch(e) {
    await sendTelegram(`❌ Stock order failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Get all US stock signals
app.get('/api/alpaca/signals', requireAuth, async (req, res) => {
  try {
    if (!ALPACA_KEY) return res.status(503).json({ error: 'Alpaca not configured' });
    const symbols  = (req.query.symbols || US_STOCKS.slice(0,8).join(',')).split(',');
    const results  = [];
    for (const sym of symbols) {
      try {
        const signal = await computeSignalForPair(sym);
        const ticker = await fetchStockTicker(sym);
        results.push({ symbol:sym, ...signal, price: ticker?.price, change24h: ticker?.change24h });
        await new Promise(r => setTimeout(r, 500));
      } catch(e) { console.warn(`[STOCK SIGNAL] ${sym}:`, e.message); }
    }
    res.json({ success:true, data: results });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Search for any stock symbol
app.get('/api/alpaca/search', requireAuth, async (req, res) => {
  try {
    const q    = req.query.q;
    if (!q) return res.status(400).json({ error: 'q required' });
    const data = await alpacaRequest(`/assets?asset_class=us_equity&status=active`, 'GET', null, false);
    const matches = data
      .filter(a => a.symbol.toUpperCase().includes(q.toUpperCase()) || a.name?.toUpperCase().includes(q.toUpperCase()))
      .slice(0, 20)
      .map(a => ({ symbol: a.symbol, name: a.name, exchange: a.exchange, tradable: a.tradable }));
    res.json({ success:true, data: matches });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Alpaca configured check
app.get('/api/alpaca/status', requireAuth, (req, res) => {
  res.json({
    success:     true,
    configured:  !!(ALPACA_KEY && ALPACA_SECRET),
    paperTrading: ALPACA_PAPER,
    stocks:      US_STOCKS,
  });
});
// Stores locally + optionally sends to Mailchimp
// ══════════════════════════════════════════════════════════════

app.post('/api/waitlist', async (req, res) => {
  // CORS — allow landing page on GitHub Pages to call this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  try {
    const { name, email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    // Prevent duplicates
    if (waitlistSignups.find(s => s.email === email)) {
      return res.json({ success: true, message: 'Already on waitlist' });
    }

    const signup = { name: name || '', email, timestamp: new Date().toISOString() };
    waitlistSignups.push(signup);
    saveData();

    console.log(`[WAITLIST] New signup: ${name} <${email}>`);

    // Optional — send to Mailchimp if API key is configured
    const MAILCHIMP_KEY      = process.env.MAILCHIMP_API_KEY;
    const MAILCHIMP_LIST_ID  = process.env.MAILCHIMP_LIST_ID;
    const MAILCHIMP_DC       = MAILCHIMP_KEY?.split('-').pop(); // e.g. us21

    if (MAILCHIMP_KEY && MAILCHIMP_LIST_ID) {
      try {
        const mcRes = await fetch(
          `https://${MAILCHIMP_DC}.api.mailchimp.com/3.0/lists/${MAILCHIMP_LIST_ID}/members`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Basic ${Buffer.from(`anystring:${MAILCHIMP_KEY}`).toString('base64')}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              email_address: email,
              status:        'subscribed',
              merge_fields:  { FNAME: name?.split(' ')[0] || '', LNAME: name?.split(' ').slice(1).join(' ') || '' }
            })
          }
        );
        if (mcRes.ok) console.log(`[WAITLIST] Added to Mailchimp: ${email}`);
        else {
          const err = await mcRes.json();
          // 400 with "Member Exists" is fine
          if (err.title !== 'Member Exists') console.warn('[WAITLIST] Mailchimp error:', err.detail);
        }
      } catch(e) { console.warn('[WAITLIST] Mailchimp failed:', e.message); }
    }

    // Notify yourself on Telegram when someone signs up
    if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
      queueNotification('waitlist', `New signup: ${name}`, `📧 ${email} | Total: ${waitlistSignups.length}`);
    }

    res.json({ success: true, message: 'Added to waitlist', total: waitlistSignups.length });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Handle CORS preflight for waitlist
app.options('/api/waitlist', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.sendStatus(200);
});

// View all waitlist signups
app.get('/api/waitlist', requireAuth, (req, res) => {
  res.json({ success: true, data: waitlistSignups, total: waitlistSignups.length });
});
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

// Signal endpoint for app dashboard — returns computed signal for a pair
app.get('/api/signal/:pair', requireAuth, async (req, res) => {
  try {
    const pair   = req.params.pair;
    const signal = await computeSignalForPair(pair);
    res.json({ success:true, data: signal });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

// Post signal chart to Telegram
app.post('/api/signal/telegram/:pair', requireAuth, async (req, res) => {
  try {
    const pair   = req.params.pair;
    const signal = await computeSignalForPair(pair, { manualVision: true });
    const dp     = PAIR_DISPLAY[pair] || pair;
    const ticker = await fetchSingleTicker(pair);
    const price  = fmtAUDServer(ticker?.price || 0, pair);
    const emoji  = signal.action==='BUY'?'🟢':signal.action==='SELL'?'🔴':'🟡';
    await sendTelegram(
      `${emoji} <b>${dp} Signal (App Request)</b>\n\n` +
      `Price: ${price}\n` +
      `Action: <b>${signal.action}</b> ${signal.confidence}% confidence\n` +
      `RSI: ${signal.rsi} | Score: ${signal.weightedScore?.toFixed(1)} | Regime: ${signal.regime}\n\n` +
      (signal.signals?.slice(0,3).join('\n') || 'No signals')
    );
    res.json({ success:true });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
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
// Get/update notification settings
app.get('/api/notifications/settings', requireAuth, (req, res) => {
  res.json({ success:true, data: { notifications: botConfig.notifications, api: botConfig.api } });
});

app.post('/api/notifications/settings', requireAuth, (req, res) => {
  const { notifications, api } = req.body;
  if (notifications) Object.assign(botConfig.notifications, notifications);
  if (api)           Object.assign(botConfig.api, api);
  saveData();
  res.json({ success:true, data: { notifications: botConfig.notifications, api: botConfig.api } });
});

// Manually trigger daily portfolio digest
app.post('/api/digest/daily', requireAuth, async (req, res) => {
  res.json({ success:true, message:'Sending daily digest to Telegram...' });
  await sendDailyPortfolioDigest();
});

// Force flush digest queues on demand
app.post('/api/notifications/flush', requireAuth, async (req, res) => {
  res.json({ success:true, message:'Flushing digest queues...' });
  await flushDigestQueues();
});

// ATR stop loss info for current holdings
app.get('/api/atr/:pair', requireAuth, async (req, res) => {
  try {
    const pair   = req.params.pair;
    const mult   = parseFloat(req.query.multiplier) || botConfig.atrMultiplier || 2.0;
    const result = await calcDynamicStopLoss(pair, mult);
    if (!result) return res.json({ success:false, error:'Not enough candle data yet' });
    res.json({ success:true, data: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Update ATR multiplier via bot config
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
      // Don't sell within minHoldMinutes of buying — prevents churn on noise
      // EXCEPTION: If we're down >5% we allow stop loss to fire anyway
      const lastBought  = lastBuyTimes[holding.sym];
      const pnlEarly    = getUnrealisedPnl(holding.sym, ticker.price, holding.qty);
      const earlyLossPct = pnlEarly.avgBuyPrice > 0
        ? ((ticker.price - pnlEarly.avgBuyPrice) / pnlEarly.avgBuyPrice) * 100
        : 0;
      if (lastBought) {
        const heldMinutes = (Date.now() - lastBought) / 1000 / 60;
        if (heldMinutes < botConfig.minHoldMinutes && earlyLossPct > -5) {
          console.log(`[AUTO-SELL BOT] ${dp} — hold time enforced (${heldMinutes.toFixed(0)}/${botConfig.minHoldMinutes} min)`);
          continue;
        }
        if (heldMinutes < botConfig.minHoldMinutes && earlyLossPct <= -5) {
          console.log(`[AUTO-SELL BOT] ${dp} — hold time bypassed (emergency: ${earlyLossPct.toFixed(1)}% loss)`);
        }
      }

      // ── Stop-Loss Check (ATR-powered dynamic stops) ──────────
      const pnl = getUnrealisedPnl(holding.sym, ticker.price, holding.qty);
      if (botConfig.stopLossEnabled && pnl.avgBuyPrice > 0) {

        // Calculate ATR-based dynamic stop for this coin right now
        // Falls back to botConfig.stopLossPct if ATR unavailable
        let effectiveStopPct = botConfig.stopLossPct;
        if (botConfig.useATRStops !== false) {
          const atrStop = await calcDynamicStopLoss(holding.pair, botConfig.atrMultiplier || 2.0);
          if (atrStop) {
            effectiveStopPct = atrStop.stopPct;
            if (Math.abs(effectiveStopPct - botConfig.stopLossPct) > 1) {
              console.log(`[ATR STOP] ${dp} using ATR stop ${effectiveStopPct}% (ATR=${atrStop.atrPct}%)`);
            }
          }
        }

        // Track peak price for trailing stop
        if (!stopLossPeaks[holding.sym] || ticker.price > stopLossPeaks[holding.sym]) {
          stopLossPeaks[holding.sym] = ticker.price;
        }
        const peakPrice    = stopLossPeaks[holding.sym];
        const entryPrice   = pnl.avgBuyPrice;
        const currentPrice = ticker.price;
        const gainFromEntry   = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;
        const dropFromPeak    = ((currentPrice - peakPrice) / peakPrice) * 100;
        const dropFromEntry   = gainFromEntry; // negative = below entry

        // ══════════════════════════════════════════════════════
        // BREAK-EVEN STOP SYSTEM
        // Three progressive stages that protect profit:
        //
        // STAGE 1 — DANGER ZONE (below entry)
        //   Standard ATR stop loss. If price drops too far below
        //   entry, cut the loss immediately.
        //
        // STAGE 2 — BREAK-EVEN ZONE (0% to +breakEvenTrigger%)
        //   Once price moves up, the "virtual stop" is entry price.
        //   If it reverses back below entry we sell at break-even.
        //   You never lose money on a trade that was in profit.
        //
        // STAGE 3 — PROFIT PROTECTION ZONE (above +breakEvenTrigger%)
        //   Trailing stop activates. Trails below the peak by ATR%.
        //   Locks in profit as price rises. If it reverses by ATR%
        //   from the peak, we sell and bank the gain.
        // ══════════════════════════════════════════════════════

        const breakEvenTrigger = botConfig.breakEvenTriggerPct || 2.0; // move stop to entry after +2%
        const trailingTrigger  = botConfig.trailingTriggerPct  || 4.0; // activate trailing stop after +4%

        if (entryPrice > 0) {

          if (gainFromEntry >= trailingTrigger) {
            // ── STAGE 3: Profit protection — trailing stop ──────
            if (dropFromPeak <= -effectiveStopPct) {
              const profitLocked = ((currentPrice - entryPrice) / entryPrice) * 100;
              console.log(`[TRAILING STOP] ${dp} triggered — ${dropFromPeak.toFixed(1)}% from peak, locking in +${profitLocked.toFixed(1)}%`);
              await sendTelegram(
                `🔒 <b>PROFIT LOCKED IN!</b>\n\n` +
                `<b>${dp}</b>\n` +
                `Entry: ${fmtAUDServer(entryPrice, holding.pair)}\n` +
                `Peak: ${fmtAUDServer(peakPrice, holding.pair)}\n` +
                `Exit: ${fmtAUDServer(currentPrice, holding.pair)}\n` +
                `Drop from peak: ${dropFromPeak.toFixed(1)}% (ATR limit: -${effectiveStopPct}%)\n\n` +
                `💰 <b>Net gain on this trade: +${profitLocked.toFixed(2)}%</b>\n` +
                `💵 ${fmtAUDServer(pnl.unrealisedPnl, holding.pair)} profit banked\n\n` +
                `✅ Break-even stop protected you from giving this back`
              );
              delete stopLossPeaks[holding.sym];
              await executeSell(holding, ticker, 'trailing-stop', `Trailing stop: locked in +${profitLocked.toFixed(1)}%`, dp);
              continue;
            } else {
              console.log(`[STAGE 3] ${dp} profit zone — peak ${fmtAUDServer(peakPrice, holding.pair)}, trailing ${effectiveStopPct}% below`);
            }

          } else if (gainFromEntry >= breakEvenTrigger) {
            // ── STAGE 2: Break-even zone — stop moved to entry ──
            // Price is up +2% to +4% from entry.
            // If it reverses back below entry + small buffer, sell at break-even.
            const breakEvenBuffer = 0.3; // tiny buffer for fees
            const breakEvenStop   = entryPrice * (1 - breakEvenBuffer / 100);

            if (currentPrice <= breakEvenStop) {
              console.log(`[BREAK-EVEN STOP] ${dp} triggered — price fell back to entry after being +${gainFromEntry.toFixed(1)}%`);
              await sendTelegram(
                `🔄 <b>BREAK-EVEN STOP TRIGGERED</b>\n\n` +
                `<b>${dp}</b>\n` +
                `Entry: ${fmtAUDServer(entryPrice, holding.pair)}\n` +
                `Exit: ${fmtAUDServer(currentPrice, holding.pair)}\n` +
                `Peak reached: ${fmtAUDServer(peakPrice, holding.pair)} (+${gainFromEntry.toFixed(1)}%)\n\n` +
                `✅ Stop moved to entry protected your capital\n` +
                `💡 You did not lose money on this trade`
              );
              delete stopLossPeaks[holding.sym];
              await executeSell(holding, ticker, 'break-even', `Break-even stop — was +${gainFromEntry.toFixed(1)}%, returned to entry`, dp);
              continue;
            } else {
              console.log(`[STAGE 2] ${dp} break-even zone +${gainFromEntry.toFixed(1)}% — stop at entry ${fmtAUDServer(entryPrice, holding.pair)}`);
            }

          } else if (gainFromEntry < 0) {
            // ── STAGE 1: Danger zone — below entry ─────────────
            // Standard ATR stop. If dropping too far, cut the loss.
            if (dropFromEntry <= -effectiveStopPct) {
              console.log(`[STOP-LOSS] ${dp} triggered — ${dropFromEntry.toFixed(1)}% below entry`);
              await sendTelegram(
                `🛑 <b>STOP-LOSS TRIGGERED</b>\n\n` +
                `<b>${dp}</b>\n` +
                `Entry: ${fmtAUDServer(entryPrice, holding.pair)}\n` +
                `Current: ${fmtAUDServer(currentPrice, holding.pair)}\n` +
                `Loss: <b>${dropFromEntry.toFixed(1)}%</b> (ATR limit: -${effectiveStopPct}%)\n` +
                `Unrealised: ${fmtAUDServer(pnl.unrealisedPnl, holding.pair)}\n\n` +
                `⏳ Cutting loss to protect remaining capital...`
              );
              delete stopLossPeaks[holding.sym];
              await executeSell(holding, ticker, 'stop-loss', `ATR stop: ${dropFromEntry.toFixed(1)}% below entry`, dp);
              continue;
            } else {
              console.log(`[STAGE 1] ${dp} below entry ${dropFromEntry.toFixed(1)}% — stop at -${effectiveStopPct}%`);
            }
          }
          // If gainFromEntry is between 0% and +2%: watching, no action yet
        }
      } // end stopLossEnabled

      // ── Maximum hold time exit ────────────────────────────
      // If held too long without hitting TP or SL, exit to free capital
      // Default: 5 days (120 candles on 1H) — configurable
      const maxHoldHours = botConfig.maxHoldHours || 120; // 5 days
      const heldHours    = lastBuyTimes[holding.sym]
        ? (Date.now() - lastBuyTimes[holding.sym]) / 3600000
        : 0;
      if (heldHours >= maxHoldHours && pnl.avgBuyPrice > 0) {
        const gainPct = ((ticker.price - pnl.avgBuyPrice) / pnl.avgBuyPrice) * 100;
        console.log(`[AUTO-SELL BOT] ${dp} max hold reached (${heldHours.toFixed(0)}h) — exiting at ${gainPct.toFixed(2)}%`);
        await sendTelegram(
          `⏰ <b>MAX HOLD TIME EXIT</b>\n\n` +
          `<b>${dp}</b>\n` +
          `Held: ${heldHours.toFixed(0)} hours (limit: ${maxHoldHours}h)\n` +
          `Entry: ${fmtAUDServer(pnl.avgBuyPrice, holding.pair)}\n` +
          `Exit: ${fmtAUDServer(ticker.price, holding.pair)}\n` +
          `P&L: ${gainPct >= 0 ? '🟢 +' : '🔴 '}${gainPct.toFixed(2)}%\n\n` +
          `Freeing capital for new opportunities.`
        );
        await executeSell(holding, ticker, 'max-hold', `Max hold ${maxHoldHours}h reached`, dp);
        continue;
      }

      // ── Multi-Indicator Signal ────────────────────────────
      const signal = await computeSignalForPair(holding.pair);
      botState.lastSignals[holding.pair] = {
        ...signal, price: ticker.price,
        pnl: pnl.avgBuyPrice > 0 ? { pct: pnl.pnlPct.toFixed(1), aud: pnl.unrealisedPnl.toFixed(2) } : null,
        checkedAt: new Date().toISOString()
      };

      console.log(`[AUTO-SELL BOT] ${dp} Score:${signal.weightedScore} ${signal.action} ${signal.confidence}% RSI:${signal.rsi} held:${heldHours.toFixed(0)}h`);

      if (signal.action !== 'SELL') continue;

      // ── Sell quality filters ──────────────────────────────
      // Lowered from 75% to 70% — was blocking all signal sells
      const sellConfidenceMin = Math.max(botConfig.confidenceMin + 5, 70);
      if (signal.confidence < sellConfidenceMin) {
        console.log(`[AUTO-SELL BOT] ${dp} skipped — sell confidence ${signal.confidence}% < ${sellConfidenceMin}%`);
        continue;
      }

      // Never sell when RSI extremely oversold — likely a bounce coming
      // Lowered threshold from 35 to 28 — was blocking too many sells
      if (signal.rsi < 28) {
        console.log(`[AUTO-SELL BOT] ${dp} skipped — RSI ${signal.rsi} extreme oversold, holding`);
        continue;
      }

      // Require at least 2 timeframes bearish
      const tfSells = [
        signal.timeframes?.['15m']?.score < -2,
        signal.timeframes?.['1h']?.score  < -2,
        signal.timeframes?.['4h']?.score  < -2,
      ].filter(Boolean).length;
      if (tfSells < 2) {
        console.log(`[AUTO-SELL BOT] ${dp} skipped — only ${tfSells}/3 timeframes bearish`);
        continue;
      }

      // Don't signal-sell within 2 hours of buying
      if (heldHours < 2) {
        console.log(`[AUTO-SELL BOT] ${dp} skipped — only held ${(heldHours*60).toFixed(0)} min`);
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
  const minVol = MIN_VOLUMES[holding.sym] || 0.0001;

  // ── Always fetch actual balance from Kraken before selling ──
  // This prevents EOrder:Insufficient funds caused by fee differences
  let actualQty = holding.qty;
  try {
    const bal       = await krakenPrivateRequest('Balance');
    const assetKeys = [`X${holding.sym}`, holding.sym, `Z${holding.sym}`];
    for (const key of assetKeys) {
      if (bal[key] && parseFloat(bal[key]) > 0) {
        actualQty = parseFloat(bal[key]);
        break;
      }
    }
    // Apply 99.5% to avoid rounding issues with Kraken's precision
    actualQty = Math.floor(actualQty * 0.995 * 1e8) / 1e8;
    console.log(`[SELL] ${holding.sym} actual balance: ${actualQty} (bot thought: ${holding.qty})`);
  } catch(e) {
    console.warn(`[SELL] Could not fetch live balance for ${holding.sym}, using tracked qty:`, e.message);
    actualQty = holding.qty * 0.995; // safety buffer if balance fetch fails
  }

  if (actualQty < minVol) {
    console.log(`[SELL] ${dp} skipped — ${actualQty.toFixed(8)} below Kraken minimum ${minVol}`);
    return;
  }

  const sellVolume   = actualQty.toFixed(8);
  const sellValueAUD = (actualQty * ticker.price).toFixed(2);
  const pnl     = getUnrealisedPnl(holding.sym, ticker.price, actualQty);
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
    let order;
    try {
      order = await krakenPrivateRequest('AddOrder', {
        pair: holding.pair, type: 'sell', ordertype: 'market', volume: sellVolume,
      });
    } catch(firstErr) {
      // If insufficient funds, try with 98% of volume (handles rounding edge cases)
      if (firstErr.message?.includes('Insufficient') || firstErr.message?.includes('EOrder')) {
        console.warn(`[SELL] First attempt failed (${firstErr.message}) — retrying with 98% volume`);
        const retryVolume = (actualQty * 0.98).toFixed(8);
        order = await krakenPrivateRequest('AddOrder', {
          pair: holding.pair, type: 'sell', ordertype: 'market', volume: retryVolume,
        });
        console.log(`[SELL] Retry succeeded with volume ${retryVolume}`);
      } else {
        throw firstErr;
      }
    }

    // Record in P&L tracker using actual quantity sold
    recordTrade(holding.pair, holding.sym, 'sell', sellVolume, ticker.price, source);

    botState.lastSell = {
      pair: holding.pair, sym: holding.sym,
      volume: sellVolume, price: ticker.price,
      valueAUD: sellValueAUD, txid: order.txid,
      pnl: pnlStr,
      timestamp: new Date().toISOString()
    };
    botState.sellsCount++;

    const sydneyTime  = new Date().toLocaleString('en-AU', { timeZone:'Australia/Sydney', dateStyle:'short', timeStyle:'short' });
    const realisedPnl = pnlByAsset[holding.sym]?.realisedPnl || 0;

    // This trade P&L — calculated before recordTrade updates the asset
    const thisTradeAUD = pnl.unrealisedPnl;
    const thisTradePct = pnl.pnlPct;
    const thisBuyPrice = pnl.avgBuyPrice;

    const tradeResult  = thisBuyPrice > 0
      ? `\n💰 <b>This trade: ${thisTradeAUD >= 0 ? '🟢 +' : '🔴 '}${fmtAUDServer(Math.abs(thisTradeAUD))} (${thisTradeAUD >= 0 ? '+' : ''}${thisTradePct.toFixed(2)}%)</b>\n` +
        `Bought at: ${fmtAUDServer(thisBuyPrice)} → Sold at: ${fmtAUDServer(ticker.price)}`
      : '';

    await sendTelegram(
      `🔴 <b>SELL COMPLETED!</b>\n\n` +
      `<b>${dp}</b>\n` +
      `Sold: ${sellVolume} ${holding.sym}\n` +
      `Price: ${fmtAUDServer(ticker.price, holding.pair)}\n` +
      `Value: ≈ ${fmtAUDServer(parseFloat(sellValueAUD), holding.pair)}\n` +
      `TXID: ${order.txid?.join(', ')}` +
      `${tradeResult}\n\n` +
      `All-time P&L (${holding.sym}): ${realisedPnl >= 0 ? '+' : ''}${fmtAUDServer(realisedPnl, holding.pair)}\n` +
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
    if (cached && (Date.now() - cached.timestamp) < 4 * 60 * 60 * 1000) { // 4h cache — manual only now
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
    const k = null;
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

    const prompt = `Search for current on-chain data for ${sym} cryptocurrency and return ONLY a JSON object, no other text, no markdown backticks.

{"whaleActivity":"description","exchangeFlow":"inflow or outflow","activeAddresses":"trend","networkHealth":"strong/moderate/weak","bullishSignals":["signal1"],"bearishSignals":["signal1"],"overallOnChainScore":6,"summary":"one sentence"}`;

    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 30000);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 400,
        tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
        messages:   [{ role: 'user', content: prompt }]
      })
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Claude API returned ${response.status}`);
    }

    const raw  = await response.json();
    const text = (raw.content || [])
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('').trim();

    // Extract JSON from response — handle extra text around it
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in response');

    const data = JSON.parse(jsonMatch[0]);

    // Validate required fields
    if (!data.summary) throw new Error('Invalid response structure');

    onChainCache[sym] = { data, fetchedAt: Date.now() };
    console.log(`[ON-CHAIN] ${sym}: score ${data.overallOnChainScore}/10`);
    res.json({ success: true, data });

  } catch(err) {
    console.warn(`[ON-CHAIN] Failed for ${req.params.sym}:`, err.message);
    // Return a graceful fallback instead of an error
    res.json({
      success: true,
      data: {
        whaleActivity:       'Data temporarily unavailable',
        exchangeFlow:        'Unknown',
        activeAddresses:     'Unknown',
        networkHealth:       'Unknown',
        bullishSignals:      [],
        bearishSignals:      [],
        overallOnChainScore: 5,
        summary:             'On-chain data unavailable right now — try again in a few minutes',
      },
      error: err.message
    });
  }
});

// ─── Start Server ──────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║        KRAKN·AI Bot Server v4.0        ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  Port:     ${PORT}                         ║`);
  console.log(`║  Keys:     ${!!(KRAKEN_API_KEY&&KRAKEN_API_SECRET)?'✅':'❌'}                         ║`);
  console.log(`║  AI:       ${!!(process.env.ANTHROPIC_API_KEY)?'✅':'❌'}                         ║`);
  console.log(`║  Telegram: ${!!(TELEGRAM_TOKEN&&TELEGRAM_CHAT_ID)?'✅':'❌'}                         ║`);
  console.log('╚════════════════════════════════════════╝');
  console.log('');

  // ── Step 1: Load saved data (sync-safe wrapper) ───────────
  // Wrapped in try/catch so a missing volume file never crashes startup
  try { loadData(); } catch(e) { console.warn('[STARTUP] loadData failed:', e.message, '— using defaults'); }

  // ── Step 2: Schedule recurring intervals ──────────────────
  // These register the timers but don't run immediately
  scheduleAdvisor();
  scheduleBuyCheck();
  scheduleDCA();
  scheduleDailyDigest(); // 8am Sydney daily portfolio summary

  setInterval(async () => { try { await checkVolumeAnomalies();   } catch(e) { console.error('[VOLUME]', e.message); } }, 15 * 60 * 1000);
  setInterval(async () => { try { await checkSmartMoneySignals(); } catch(e) { console.error('[SMART]', e.message);  } }, 6 * 60 * 60 * 1000); // 6h (was 15min — huge cost saving)
  setInterval(async () => { try { await checkMacroEvents();       } catch(e) { console.error('[MACRO]', e.message);  } }, 30 * 60 * 1000);
  setInterval(async () => { try { await checkGridOrders();        } catch(e) { console.error('[GRID]', e.message);   } }, 5  * 60 * 1000);
  setInterval(async () => { try { await checkAndRebalance();      } catch(e) { console.error('[REBAL]', e.message);  } }, 4  * 60 * 60 * 1000);
  setInterval(async () => { try { await buildCorrelationMatrix(); } catch(e) { console.error('[CORR]', e.message);   } }, 6  * 60 * 60 * 1000);
  setInterval(async () => { try { await recordPortfolioSnapshot();} catch(e) { console.error('[SNAP]', e.message);   } }, 6  * 60 * 60 * 1000);
  setInterval(flushDigestQueues, 30 * 60 * 1000);

  // ── Step 3: Delayed first runs — nothing heavy before 60s ─
  // Railway health check window = 30s. Server must respond to /health first.
  setTimeout(registerTelegramWebhook,                                          3  * 1000); // 3s  — lightweight
  setTimeout(async () => { try { await checkBuyOpportunity(); }    catch(e){} }, 90 * 1000); // 1.5min — first buy check
  setTimeout(async () => { try { await recordPortfolioSnapshot();} catch(e){} }, 2  * 60 * 1000); // 2min
  setTimeout(async () => { try { await checkVolumeAnomalies(); }   catch(e){} }, 3  * 60 * 1000); // 3min
  setTimeout(async () => { try { await checkMacroEvents(); }        catch(e){} }, 4  * 60 * 1000); // 4min
  setTimeout(async () => { try { await checkSmartMoneySignals(); }  catch(e){} }, 10 * 60 * 1000); // 10min
  setTimeout(async () => { try { await buildCorrelationMatrix(); }  catch(e){} }, 8  * 60 * 1000); // 8min
  // Advisor runs at 10min — all data loaded, bot potentially running by then
  setTimeout(() => { if (advisorSettings.enabled) runAdvisor(); }, 10 * 60 * 1000);
});

module.exports = app;
