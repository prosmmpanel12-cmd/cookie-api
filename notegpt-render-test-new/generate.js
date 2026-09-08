/**
 * NoteGPT image-generation interoperability test.
 * Proxy-enabled version — scrapes free proxies at runtime to bypass datacenter IP block.
 *
 * CLI:
 *   node generate.js "your prompt" 16:9
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Browser globals for WASM glue ───────────────────────────────────────────
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
if (typeof globalThis.navigator === 'undefined') {
  globalThis.navigator = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0',
    webdriver: false,
    language: 'en-US',
    languages: ['en-US', 'en'],
  };
}
if (typeof globalThis.location === 'undefined') {
  globalThis.location = {
    href: 'https://notegpt.io/ai-image-generator',
    protocol: 'https:',
    host: 'notegpt.io',
    hostname: 'notegpt.io',
    pathname: '/ai-image-generator',
  };
}
if (typeof globalThis.document === 'undefined') {
  const fakeEl = () => ({
    style: {}, setAttribute() {}, getAttribute() { return null; }, appendChild() {},
    removeChild() {}, clientWidth: 1200, children: [], innerHTML: '',
  });
  globalThis.document = {
    body: fakeEl(), documentElement: fakeEl(), createElement: () => fakeEl(),
    getElementsByTagName: () => [], querySelector: () => null, cookie: '',
  };
}
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.getRandomValues) {
  const nodeCrypto = await import('crypto');
  globalThis.crypto = {
    getRandomValues(arr) { const buf = nodeCrypto.randomBytes(arr.length); arr.set(buf); return arr; },
    subtle: nodeCrypto.webcrypto?.subtle,
  };
}

// ─── Canonicalize (matches NoteGPT frontend) ─────────────────────────────────
function G(value) {
  if (value === null) return String(value);
  if (Array.isArray(value)) return JSON.stringify(value);

  if (typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = value[key];
    return JSON.stringify(sorted);
  }

  return String(value);
}

function canonicalize(obj) {
  return Object.keys(obj)
    .filter(key => obj[key] !== undefined)
    .sort()
    .map(key => {
      const value = obj[key];
      return value && typeof value === 'object'
        ? `${key}=${G(value)}`
        : `${key}=${String(value)}`;
    })
    .join('&');
}

// ─── WASM signer ─────────────────────────────────────────────────────────────
let signPromise;
async function loadSigner() {
  if (!signPromise) {
    signPromise = (async () => {
      const glue = path.join(__dirname, 'C4xuznWB.js');
      const wasm = path.join(__dirname, 'crypto_util_bg.Bd4ztPln.wasm');
      if (!fs.existsSync(glue)) throw new Error('Missing C4xuznWB.js');
      if (!fs.existsSync(wasm)) throw new Error('Missing crypto_util_bg.Bd4ztPln.wasm');
      const mod = await import(pathToFileURL(glue).href);
      const wasmBytes = fs.readFileSync(wasm);
      if (typeof mod.initSync === 'function') {
        mod.initSync({ module: wasmBytes });
      } else if (typeof mod.default === 'function') {
        await mod.default(wasmBytes);
      }
      if (typeof mod.sign !== 'function') throw new Error('WASM export `sign` not found');
      return mod.sign;
    })();
  }
  return signPromise;
}

// ─── HTTP headers ─────────────────────────────────────────────────────────────
const HEADERS = {
  'content-type': 'application/json; charset=UTF-8',
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9,en-IN;q=0.8',
  origin: 'https://notegpt.io',
  referer: 'https://notegpt.io/ai-image-generator',
  'user-agent': process.env.TEST_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0',
  'sec-ch-ua': '"Chromium";v="152", "Not?A_Brand";v="24", "Microsoft Edge";v="152"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  priority: 'u=1, i',
};

// ─── Per-generation cookie jar ────────────────────────────────────────────────
// Stores only cookies actually returned by the server via Set-Cookie.
// No fabricated analytics/Crisp cookies are created.
function makeCookieJar() {
  const jar = new Map();

  return {
    setFromResponse(response) {
      const lines = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [];

      for (const line of lines) {
        const first = String(line).split(';', 1)[0];
        const eq = first.indexOf('=');
        if (eq <= 0) continue;
        jar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
      }
    },

    header() {
      return [...jar.entries()]
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
    },

    names() {
      return [...jar.keys()];
    }
  };
}

async function requestJson(url, options = {}, cookieJar = null) {
  const headers = new Headers({ ...HEADERS, ...(options.headers || {}) });

  if (cookieJar) {
    const cookies = cookieJar.header();
    if (cookies) headers.set('cookie', cookies);
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (cookieJar) cookieJar.setFromResponse(response);

  const body = await response.text();
  let data;
  try { data = JSON.parse(body); }
  catch { data = { _raw: body }; }

  return { status: response.status, ok: response.ok, data };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function pickImageId(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.image_id) return data.image_id;
  if (data.imageId) return data.imageId;
  if (Array.isArray(data.list) && data.list[0]?.image_id) return data.list[0].image_id;
  if (Array.isArray(data.images) && data.images[0]?.image_id) return data.images[0].image_id;
  if (data.data) return pickImageId(data.data);
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Main export ──────────────────────────────────────────────────────────────
export async function generateImage({ prompt, aspect = '16:9' } = {}) {
  if (!prompt || typeof prompt !== 'string') throw new Error('prompt is required');
  if (prompt.length > 4000) throw new Error('prompt is too long (max 4000 characters)');
  if (!['16:9', '9:16', '1:1'].includes(aspect)) throw new Error('aspect must be 16:9, 9:16, or 1:1');

  const cookieJar = makeCookieJar();

  // Browser-style anonymous identifier used by the site.
  // Keep it as a per-generation local session value; do not copy a user's
  // real browser cookie/session into the server.
  const anonymousUserId = crypto.randomUUID
    ? crypto.randomUUID()
    : [...crypto.getRandomValues(new Uint8Array(16))]
        .map(b => b.toString(16).padStart(2, '0')).join('');

  // Bootstrap the same site origin first so any server-issued cookies are
  // captured into the jar before the API request.
  await requestJson('https://notegpt.io/ai-image-generator', {
    method: 'GET',
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'user-agent': process.env.TEST_USER_AGENT || HEADERS['user-agent'],
    },
  }, cookieJar);

  const signFn = await loadSigner();
  const params = {
    image_urls: [],
    type: 60,
    user_prompt: prompt,
    aspect_ratio: aspect,
    num: 1,
    sub_type: 19,
    resolution: '1K',
    t: Math.floor(Date.now() / 1000),
    app_id: APP_ID,
  };
  const signature = await signFn(params.app_id, canonicalize(params));

  console.log(`[session] bootstrap cookies: ${cookieJar.names().join(', ') || 'none'}`);
  console.log(`[request] start: type=${params.type} sub_type=${params.sub_type} aspect=${params.aspect_ratio} resolution=${params.resolution} num=${params.num}`);

  const start = await requestJson('https://notegpt.io/api/v2/images/start', {
    method: 'POST',
    body: JSON.stringify({ ...params, sign: signature }),
  }, cookieJar);

  if (start.data?.code !== 100000 || !start.data?.data?.session_id) {
    throw new Error(`Generation start failed (HTTP ${start.status}): ${JSON.stringify(start.data).slice(0, 1200)}`);
  }

  const sessionId = start.data.data.session_id;
  let imageId = null;
  let imageUrl = null;
  let lastStatus = null;

  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const st = await requestJson(
      `https://notegpt.io/api/v2/images/status?session_id=${encodeURIComponent(sessionId)}`
    , {}, cookieJar);
    imageId = pickImageId(st.data);
    const results = st.data?.data?.results;
    if (Array.isArray(results) && results[0]?.url?.length > 0) {
      imageUrl = results[0].url[0];
    }
    lastStatus = st.data?.data?.status || st.data?.data?.state || st.data?.status || null;
    if (imageId) break;
    if (lastStatus === 'failed' || lastStatus === 'error') {
      throw new Error(`Generation failed: ${JSON.stringify(st.data).slice(0, 1200)}`);
    }
  }

  if (!imageId) throw new Error(`Timed out waiting for image_id (last status: ${lastStatus ?? 'unknown'})`);

  return { success: true, session_id: sessionId, image_id: imageId, image_url: imageUrl };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
async function main() {
  const prompt = process.argv[2] || 'a cute orange cat sitting on a windowsill, soft morning light';
  const aspect = process.argv[3] || '16:9';
  console.log(JSON.stringify(await generateImage({ prompt, aspect }), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}
