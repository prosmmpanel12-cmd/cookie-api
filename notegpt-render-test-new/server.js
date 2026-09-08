import http from 'http';
import { generateImage } from './generate.js';

const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.TEST_API_KEY || '';
const MAX_BODY = 16 * 1024;

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (Buffer.byteLength(data) > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, service: 'notegpt-test' });
  }

  if (req.method !== 'POST' || req.url !== '/generate') {
    return send(res, 404, { success: false, error: 'Not found' });
  }

  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    return send(res, 401, { success: false, error: 'Unauthorized' });
  }

  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw || '{}');
    const result = await generateImage({ prompt: body.prompt, aspect: body.aspect || '16:9' });
    return send(res, 200, result);
  } catch (err) {
    console.error(err);
    return send(res, 500, { success: false, error: err?.message || 'Internal error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on 0.0.0.0:${PORT}`);
  console.log(`Health: GET /health`);
  console.log(`Generate: POST /generate`);
  console.log(`API key protection: ${API_KEY ? 'enabled' : 'disabled'}`);
});
