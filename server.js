// ═══════════════════════════════════════════════
//  Cookie Generator API — Node.js + Express
//  Host: Render.com
//  Cache: In-Memory (per API key)
//  Usage: GET /cookies?apikey=YOUR_KEY
// ═══════════════════════════════════════════════

const express = require('express');
const https   = require('https');
const http    = require('http');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ──────────────────────────────────────────────
// CONFIG
// ──────────────────────────────────────────────
const TARGET_URL    = process.env.TARGET_URL || 'https://yourapi.42web.io/';
const REFRESH_MS    = 2 * 60 * 60 * 1000; // 2 hours
const COOKIE_COUNT  = 5;

// ──────────────────────────────────────────────
// IN-MEMORY CACHE — Map<apikey, {data, expiresAt}>
// ──────────────────────────────────────────────
const cache = new Map();

function getCache(apiKey) {
  const entry = cache.get(apiKey);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(apiKey);
    return null;
  }
  return entry;
}

function setCache(apiKey, cookies) {
  cache.set(apiKey, {
    cookies,
    generatedAt : new Date().toISOString(),
    expiresAt   : Date.now() + REFRESH_MS,
    expiresAtStr: new Date(Date.now() + REFRESH_MS).toISOString(),
  });
}

// ──────────────────────────────────────────────
// UTILS
// ──────────────────────────────────────────────
function randomUserAgent() {
  const devices = ['SM-G991B', 'SM-A536B', 'Pixel 7', 'RMX3511', 'CPH2269', 'SM-S908B', 'Pixel 8 Pro'];
  const device  = devices[Math.floor(Math.random() * devices.length)];
  const major   = Math.floor(Math.random() * 16) + 120;
  const build   = `${Math.floor(Math.random() * 1000) + 6000}.${Math.floor(Math.random() * 90) + 10}`;
  return `Mozilla/5.0 (Linux; Android 14; ${device}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.${build} Mobile Safari/537.36`;
}

function fetchRaw(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      path    : parsed.pathname + parsed.search,
      method  : options.method || 'GET',
      headers : options.headers || {},
      rejectUnauthorized: false,
    };

    const req = lib.request(reqOpts, (res) => {
      let rawHeaders = `HTTP/${res.httpVersion} ${res.statusCode}\r\n`;
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        rawHeaders += `${res.rawHeaders[i]}: ${res.rawHeaders[i+1]}\r\n`;
      }
      rawHeaders += '\r\n';

      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ headers: res.headers, rawHeaders, body, statusCode: res.statusCode }));
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

async function generateOneCookie() {
  const userAgent = randomUserAgent();

  // ── Step 1: Challenge page fetch ──
  let res1;
  try {
    res1 = await fetchRaw(TARGET_URL, { headers: { 'User-Agent': userAgent } });
  } catch (e) {
    return { success: false, error: 'Server unreachable: ' + e.message };
  }

  const body = res1.body;

  // ── Step 2: AES values extract ──
  const aesMatch = body.match(/toNumbers\("([a-f0-9]{32})"\).*?toNumbers\("([a-f0-9]{32})"\).*?toNumbers\("([a-f0-9]{32})"\)/s);
  if (!aesMatch) return { success: false, error: 'AES values nahi mili HTML mein' };

  const [, keyHex, ivHex, encHex] = aesMatch;

  // ── Step 3: AES-128-CBC Decrypt ──
  let testValue;
  try {
    const decipher   = crypto.createDecipheriv('aes-128-cbc', Buffer.from(keyHex, 'hex'), Buffer.from(ivHex, 'hex'));
    decipher.setAutoPadding(false);
    const decrypted  = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
    testValue        = decrypted.toString('hex');
  } catch (e) {
    return { success: false, error: 'AES decrypt fail: ' + e.message };
  }

  // ── Step 4: Verify request with cookie ──
  let res2;
  try {
    res2 = await fetchRaw(TARGET_URL + '?i=1', {
      headers: {
        'User-Agent': userAgent,
        'Cookie'    : `__test=${testValue}`,
      },
    });
  } catch (e) {
    return { success: false, error: 'Verify request fail: ' + e.message };
  }

  // ── Step 5: PHPSESSID extract ──
  let phpSessId = '';
  const setCookie = res2.rawHeaders.match(/Set-Cookie:\s*PHPSESSID=([a-zA-Z0-9]+)/i);
  if (setCookie) phpSessId = setCookie[1];

  let cookieString = `__test=${testValue}`;
  if (phpSessId) cookieString += `; PHPSESSID=${phpSessId}`;

  return {
    success   : true,
    cookies   : cookieString,
    user_agent: userAgent,
    __test    : testValue,
    PHPSESSID : phpSessId,
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ──────────────────────────────────────────────
// ROUTE: GET /cookies?apikey=YOUR_KEY
// ──────────────────────────────────────────────
app.get('/cookies', async (req, res) => {
  const apiKey = (req.query.apikey || '').trim();

  if (!apiKey) {
    return res.status(400).json({
      status : 'error',
      code   : 400,
      message: 'apikey missing. Use: /cookies?apikey=YOUR_KEY',
    });
  }

  // Cache hit?
  const cached = getCache(apiKey);
  if (cached) {
    return res.json({
      status      : 'success',
      source      : 'cache',
      generated_at: cached.generatedAt,
      expires_at  : cached.expiresAtStr,
      total       : cached.cookies.length,
      cookies     : cached.cookies,
    });
  }

  // Fresh generate
  const freshCookies = [];
  for (let i = 0; i < COOKIE_COUNT; i++) {
    const result = await generateOneCookie();
    if (result.success) {
      freshCookies.push({
        index     : i + 1,
        cookies   : result.cookies,
        user_agent: result.user_agent,
        __test    : result.__test,
        PHPSESSID : result.PHPSESSID,
      });
    }
    if (i < COOKIE_COUNT - 1) await sleep(2000);
  }

  if (freshCookies.length === 0) {
    return res.status(502).json({
      status : 'error',
      code   : 502,
      message: 'Cookies generate nahi hui. Target server unreachable ho sakta hai.',
    });
  }

  setCache(apiKey, freshCookies);
  const entry = getCache(apiKey);

  return res.json({
    status      : 'success',
    source      : 'fresh',
    generated_at: entry.generatedAt,
    expires_at  : entry.expiresAtStr,
    total       : freshCookies.length,
    cookies     : freshCookies,
  });
});

// ──────────────────────────────────────────────
// HEALTH CHECK
// ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Cookie API is running', cached_keys: cache.size });
});

app.listen(PORT, () => console.log(`✅ Cookie API running on port ${PORT}`));
