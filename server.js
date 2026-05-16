/**
 * KRAKN·AI — Trading Bot Backend Server v2.4
 * =============================================
 * AI Trading Advisor with news search, Telegram alerts, AUD support
 */

const express    = require('express');
const cors       = require('cors');
const crypto     = require('crypto');
const https      = require('https');
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
const TELEGRAM_TOKEN    = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID  = (process.env.TELEGRAM_CHAT_ID  || '').trim();

// ─── AUD Trading Pairs ─────────────────────────────────────────
const AUD_PAIRS = ['XBTAUD','ETHAUD','XRPAUD','ADAAUD','SOLAUD','LTCAUD','DOTAUD','LINKAUD'];
const PAIR_DISPLAY = {
  'XBTAUD':'BTC/AUD','ETHAUD':'ETH/AUD','XRPAUD':'XRP/AUD','ADAAUD':'ADA/AUD',
  'SOLAUD':'SOL/AUD','LTCAUD':'LTC/AUD','DOTAUD':'DOT/AUD','LINKAUD':'LINK/AUD'
};

// ─── Advisor Settings (can be changed via API) ─────────────────
let advisorSettings = {
  enabled:       true,
  intervalHours: 1,           // how often to run (1, 2, 4, 8, 24)
  pairs:         ['XBTAUD','ETHAUD','SOLAUD'],  // which pairs to analyse
  minConfidence: 65,          // only message if confidence >= this
  includeNews:   true,        // search web for news
  lastRun:       null,
};

// ─── Price Alerts ──────────────────────────────────────────────
let priceAlerts = [];

// ─── Advisor Loop ──────────────────────────────────────────────
let advisorTimer = null;

function scheduleAdvisor() {
  if (advisorTimer) clearInterval(advisorTimer);
  const ms = advisorSettings.intervalHours * 60 * 60 * 1000;
  advisorTimer = setInterval(() => {
    if (advisorSettings.enabled) runAdvisor();
  }, ms);
  console.log(`[ADVISOR] Scheduled every ${advisorSettings.intervalHours} hour(s)`);
}

async function runAdvisor() {
  console.log('[ADVISOR] Running market analysis...');
  advisorSettings.lastRun = new Date().toISOString();

  try {
    // 1. Get prices for all watched pairs
    const pairs  = advisorSettings.pairs.join(',');
    const result = await krakenPublicRequest('Ticker', { pair: pairs });

    const marketData = [];
    for (const [krakenPair, data] of Object.entries(result)) {
      const standardPair = Object.keys(PAIR_DISPLAY).find(p =>
        krakenPair === p || krakenPair.replace('XXBT','XBT') === p
      ) || krakenPair;
      const price     = parseFloat(data.c[0]);
      const open      = parseFloat(data.o);
      const high24h   = parseFloat(data.h[1]);
      const low24h    = parseFloat(data.l[1]);
      const volume    = parseFloat(data.v[1]);
      const change24h = (((price - open) / open) * 100).toFixed(2);

      // Get RSI from OHLC
      let rsi = 50;
      try {
        const ohlc    = await krakenPublicRequest('OHLC', { pair: standardPair, interval: 60 });
        const ohlcKey = Object.keys(ohlc).find(k => k !== 'last');
        const closes  = ohlc[ohlcKey].slice(-14).map(c => parseFloat(c[4]));
        const gains = [], losses = [];
        for (let i = 1; i < closes.length; i++) {
          const diff = closes[i] - closes[i-1];
          gains.push(Math.max(diff, 0));
          losses.push(Math.max(-diff, 0));
        }
        const avgGain = gains.reduce((a,b) => a+b, 0) / gains.length;
        const avgLoss = losses.reduce((a,b) => a+b, 0) / losses.length;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        rsi = Math.round(100 - (100 / (1 + rs)));
      } catch(e) {}

      marketData.push({ pair: standardPair, price, change24h, high24h, low24h, volume, rsi });
    }

    // 2. Get crypto news if enabled
    let newsContext = '';
    if (advisorSettings.includeNews) {
      newsContext = await fetchCryptoNews();
    }

    // 3. Ask Claude for trading advice
    const advice = await getAITradingAdvice(marketData, newsContext);

    // 4. Send Telegram message
    if (advice) {
      await sendTelegram(advice);
      console.log('[ADVISOR] Telegram message sent');
    }

  } catch(err) {
    console.error('[ADVISOR ERROR]', err.message);
  }
}

// ─── Fetch Crypto News via Anthropic web search ────────────────
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
        max_tokens: 500,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{
          role: 'user',
          content: 'Search for the latest cryptocurrency market news from the last 2 hours. Focus on Bitcoin, Ethereum, Solana price movements, any major news events, regulatory updates, or market sentiment. Return a brief 3-4 sentence summary of the most important findings.'
        }]
      })
    });

    const data = await response.json();
    if (!data.content) return '';

    const textContent = data.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join(' ');

    return textContent.slice(0, 800);
  } catch(err) {
    console.error('[NEWS ERROR]', err.message);
    return '';
  }
}

// ─── Get AI Trading Advice ─────────────────────────────────────
async function getAITradingAdvice(marketData, newsContext) {
  try {
    const marketSummary = marketData.map(d =>
      `${PAIR_DISPLAY[d.pair]||d.pair}: $${d.price.toLocaleString('en-AU')} AUD (${d.change24h > 0 ? '+' : ''}${d.change24h}% 24h, RSI: ${d.rsi}, High: $${d.high24h.toLocaleString('en-AU')}, Low: $${d.low24h.toLocaleString('en-AU')})`
    ).join('\n');

    const prompt = `You are an expert cryptocurrency trading advisor for an Australian retail investor. Analyse these markets and give clear actionable trading recommendations in AUD.

CURRENT MARKET DATA:
${marketSummary}

${newsContext ? `LATEST NEWS:\n${newsContext}` : ''}

Give a concise trading advisory message. For each coin:
- Clear recommendation: BUY / SELL / HOLD
- Confidence percentage
- One sentence reason why

Format your response EXACTLY like this (use these exact symbols):
🤖 KRAKN·AI Market Update

Then for each coin on its own line:
[emoji] [PAIR] — $[price] AUD
[action emoji] [BUY/SELL/HOLD] [confidence]% — [one sentence reason]

Use 🟢 for BUY, 🔴 for SELL, 🟡 for HOLD
Use 📈 if price up, 📉 if price down, ➡️ if flat

End with:
📰 NEWS SUMMARY: [one sentence about biggest news item if any]
⏰ [current time in Sydney AEST]

Only include coins where confidence is above ${advisorSettings.minConfidence}%. If all are below, say "Markets uncertain — no strong signals right now."`;

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
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (!data.content || !data.content.length) return null;

    const text = data.content.map(i => i.text || '').join('');

    // Add Sydney time at the bottom
    const sydneyTime = new Date().toLocaleString('en-AU', {
      timeZone: 'Australia/Sydney',
      dateStyle: 'short',
      timeStyle: 'short'
    });

    return text.replace('[current time in Sydney AEST]', sydneyTime + ' AEST');

  } catch(err) {
    console.error('[AI ADVICE ERROR]', err.message);
    return null;
  }
}

// ─── Telegram ──────────────────────────────────────────────────
async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[TELEGRAM] Not configured');
    return { ok: false, error: 'Telegram not configured' };
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
        } catch(e) { resolve({ ok: false }); }
      });
    });
    req.on('error', (e) => { console.error('[TELEGRAM ERROR]', e.message); resolve({ ok: false, error: e.message }); });
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
      hostname: KRAKEN_HOST, port: 443, path: urlPath, method: 'POST',
      headers: {
        'API-Key': KRAKEN_API_KEY, 'API-Sign': signature,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'KRAKN-AI-Bot/2.4'
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
      headers: { 'User-Agent': 'KRAKN-AI-Bot/2.4' }
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

// ─── Alert Checker ─────────────────────────────────────────────
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
        const emoji = alert.condition === 'above' ? '🚀' : '📉';
        const sydneyTime = new Date().toLocaleString('en-AU', { timeZone:'Australia/Sydney', dateStyle:'short', timeStyle:'short' });
        await sendTelegram(
          `${emoji} <b>KRAKN·AI Price Alert!</b>\n\n` +
          `<b>${displayPair}</b> is now <b>$${currentPrice.toLocaleString('en-AU', {minimumFractionDigits:2})} AUD</b>\n` +
          `Alert: Price ${alert.condition} $${alert.targetPrice.toLocaleString('en-AU', {minimumFractionDigits:2})} AUD\n\n` +
          `⏰ ${sydneyTime} AEST`
        );
      }
    }
  } catch(err) { console.error('[ALERT CHECK ERROR]', err.message); }
}

setInterval(checkPriceAlerts, 60000);

// Start advisor on boot
scheduleAdvisor();
setTimeout(() => { if (advisorSettings.enabled) runAdvisor(); }, 10000);

// ══════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({
    status: 'online', version: '2.4',
    keysConfigured: !!(KRAKEN_API_KEY && KRAKEN_API_SECRET),
    aiConfigured: !!(process.env.ANTHROPIC_API_KEY),
    telegramConfigured: !!(TELEGRAM_TOKEN && TELEGRAM_CHAT_ID),
    advisorEnabled: advisorSettings.enabled,
    advisorInterval: advisorSettings.intervalHours,
    nextRun: advisorSettings.lastRun ? new Date(new Date(advisorSettings.lastRun).getTime() + advisorSettings.intervalHours * 3600000).toISOString() : 'soon',
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

// ─── AI Signal (for app display) ──────────────────────────────
app.post('/api/ai/signal', requireAuth, async (req, res) => {
  try {
    const { pair, price, change24h } = req.body;
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY not configured' });
    const displayPair = PAIR_DISPLAY[pair] || pair;
    const prompt = `You are a crypto trading AI for an Australian investor. Analyse ${displayPair} at $${parseFloat(price).toFixed(2)} AUD (${change24h > 0 ? '+' : ''}${change24h}% 24h). Return ONLY this JSON (no markdown): {"action":"BUY","confidence":72,"reason":"Brief beginner-friendly reason","support":150000,"resistance":165000,"risk":"Medium","rsi":54,"rsi_signal":"Neutral","macd":"Bullish","trend":"Uptrend"}`;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model:'claude-sonnet-4-5', max_tokens:300, messages:[{role:'user',content:prompt}] })
    });
    const data = await response.json();
    if (!data.content || !data.content.length) return res.status(500).json({ error: 'AI error: ' + JSON.stringify(data.error) });
    const signal = JSON.parse(data.content.map(i=>i.text||'').join('').replace(/```json|```/g,'').trim());
    res.json({ success: true, data: signal });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Advisor Settings ──────────────────────────────────────────
app.get('/api/advisor/settings', requireAuth, (req, res) => {
  res.json({ success: true, data: { ...advisorSettings } });
});

app.post('/api/advisor/settings', requireAuth, (req, res) => {
  const { intervalHours, enabled, pairs, minConfidence, includeNews } = req.body;
  if (intervalHours) advisorSettings.intervalHours = parseInt(intervalHours);
  if (enabled !== undefined) advisorSettings.enabled = enabled;
  if (pairs) advisorSettings.pairs = pairs;
  if (minConfidence) advisorSettings.minConfidence = parseInt(minConfidence);
  if (includeNews !== undefined) advisorSettings.includeNews = includeNews;
  scheduleAdvisor(); // restart timer with new interval
  console.log('[ADVISOR] Settings updated:', advisorSettings);
  res.json({ success: true, data: advisorSettings });
});

// Run advisor immediately on demand
app.post('/api/advisor/run', requireAuth, async (req, res) => {
  res.json({ success: true, message: 'Running analysis now — check Telegram in ~30 seconds!' });
  runAdvisor(); // run in background
});

// ─── Price Alerts ──────────────────────────────────────────────
app.get('/api/alerts', requireAuth, (req, res) => {
  res.json({ success: true, data: priceAlerts });
});

app.post('/api/alerts', requireAuth, async (req, res) => {
  const { pair, targetPrice, condition } = req.body;
  if (!pair || !targetPrice || !condition) return res.status(400).json({ error: 'pair, targetPrice and condition required' });
  const alert = { id: Date.now().toString(), pair, targetPrice: parseFloat(targetPrice), condition, triggered: false, createdAt: new Date().toISOString() };
  priceAlerts.push(alert);
  const displayPair = PAIR_DISPLAY[pair] || pair;
  await sendTelegram(`🔔 <b>Alert Set!</b>\n\n<b>${displayPair}</b> — notify when ${condition} <b>$${parseFloat(targetPrice).toLocaleString('en-AU',{minimumFractionDigits:2})} AUD</b>`);
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
      '🤖 <b>KRAKN·AI Connected!</b>\n\n' +
      '✅ Telegram notifications are working!\n\n' +
      'You will receive:\n' +
      '📊 Hourly market analysis\n' +
      '🔔 Price alerts\n' +
      '🟢 Buy recommendations\n' +
      '🔴 Sell recommendations\n' +
      '📰 Latest crypto news\n\n' +
      '🇦🇺 All prices in AUD'
    );
    if (result && result.ok) {
      res.json({ success: true, message: 'Test message sent!' });
    } else {
      res.status(500).json({ error: 'Telegram returned: ' + JSON.stringify(result) });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Orders ────────────────────────────────────────────────────
app.post('/api/order/place', requireAuth, requireKeys, async (req, res) => {
  try {
    const { pair, type, ordertype, volume, price, leverage, validate } = req.body;
    if (!pair || !type || !ordertype || !volume) return res.status(400).json({ error: 'Missing required fields' });
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
    res.json({ success: true, data: { txid:result.txid, description:result.descr, message: validate?'Validated (not placed)':'Order placed!' } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/order/cancel', requireAuth, requireKeys, async (req, res) => {
  try {
    const { txid } = req.body;
    if (!txid) return res.status(400).json({ error: 'txid required' });
    const result = await krakenPrivateRequest('CancelOrder', { txid });
    res.json({ success: true, data: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/order/cancel-all', requireAuth, requireKeys, async (req, res) => {
  try {
    const result = await krakenPrivateRequest('CancelAll');
    res.json({ success: true, data: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Bot ───────────────────────────────────────────────────────
let botConfig = { enabled:false, riskLevel:'conservative', maxTradeAUD:150, takeProfitPct:5, stopLossPct:3, pairs:['XBTAUD'], confidenceMin:75 };
let botState  = { running:false, lastSignal:null, lastTrade:null, tradesCount:0 };

app.get('/api/bot/config',  requireAuth, (req, res) => res.json({ success:true, data:{...botConfig, state:botState} }));
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
    try { for (const pair of botConfig.pairs) await runBotForPair(pair); }
    catch(err) { console.error('[BOT]', err.message); }
    await sleep(60000);
  }
}

async function runBotForPair(pair) {
  const r = await krakenPublicRequest('Ticker', { pair });
  const k = Object.keys(r)[0];
  const price = parseFloat(r[k].c[0]);
  const open  = parseFloat(r[k].o);
  const change24h = ((price - open) / open * 100).toFixed(2);
  const signal = await computeRSI(pair);
  botState.lastSignal = { pair, signal, price, timestamp: new Date().toISOString() };
  if (signal.confidence < botConfig.confidenceMin) return;
  if (signal.action === 'BUY' || signal.action === 'SELL') {
    const type   = signal.action.toLowerCase();
    const volume = (botConfig.maxTradeAUD / price).toFixed(8);
    try {
      const order = await krakenPrivateRequest('AddOrder', { pair, type, ordertype:'market', volume });
      botState.lastTrade = { pair, type, volume, price, txid:order.txid, timestamp:new Date().toISOString() };
      botState.tradesCount++;
      const dp = PAIR_DISPLAY[pair]||pair;
      sendTelegram(`${type==='buy'?'🟢':'🔴'} <b>Bot Trade!</b>\n${type.toUpperCase()} ${volume} <b>${dp}</b>\n$${price.toLocaleString('en-AU')} AUD | RSI: ${signal.rsi}`);
    } catch(err) { console.error('[BOT ORDER]', err.message); }
  }
}

async function computeRSI(pair) {
  try {
    const ohlc = await krakenPublicRequest('OHLC', { pair, interval:60 });
    const k    = Object.keys(ohlc).find(k => k !== 'last');
    const closes = ohlc[k].slice(-14).map(c => parseFloat(c[4]));
    const gains = [], losses = [];
    for (let i = 1; i < closes.length; i++) {
      const d = closes[i] - closes[i-1];
      gains.push(Math.max(d,0)); losses.push(Math.max(-d,0));
    }
    const ag = gains.reduce((a,b)=>a+b,0)/gains.length;
    const al = losses.reduce((a,b)=>a+b,0)/losses.length;
    const rsi = 100 - (100/(1+(al===0?100:ag/al)));
    let action='HOLD', confidence=50;
    if (rsi<30) { action='BUY'; confidence=Math.min(95,60+(30-rsi)*2); }
    else if (rsi>70) { action='SELL'; confidence=Math.min(95,60+(rsi-70)*2); }
    if (botConfig.riskLevel==='conservative') confidence*=0.85;
    if (botConfig.riskLevel==='aggressive')   confidence*=1.10;
    return { action, confidence:Math.min(99,Math.round(confidence)), rsi:Math.round(rsi) };
  } catch { return { action:'HOLD', confidence:0, rsi:50 }; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════╗');
  console.log('║        KRAKN·AI Bot Server v2.4       ║');
  console.log('╠═══════════════════════════════════════╣');
  console.log(`║  Port:     ${PORT}                        ║`);
  console.log(`║  Currency: 🇦🇺 AUD                    ║`);
  console.log(`║  Keys:     ${!!(KRAKEN_API_KEY&&KRAKEN_API_SECRET)?'✅':'❌'}                        ║`);
  console.log(`║  AI:       ${!!(process.env.ANTHROPIC_API_KEY)?'✅':'❌'}                        ║`);
  console.log(`║  Telegram: ${!!(TELEGRAM_TOKEN&&TELEGRAM_CHAT_ID)?'✅':'❌'}                        ║`);
  console.log('╚═══════════════════════════════════════╝');
  console.log('');
});

module.exports = app;
