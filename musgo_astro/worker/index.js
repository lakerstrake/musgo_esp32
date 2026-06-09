// Cloudflare Worker — API del "Musgo que respira"
//
// Endpoints:
//   POST /api/data     -> guarda la última lectura del ESP32 (JSON)
//   GET  /api/data     -> devuelve la última lectura
//   GET  /api/history  -> devuelve las últimas N lecturas (máx 120)
//   GET  /api/health   -> estado del servicio
//
// Almacenamiento:
//   - Si existe el binding KV `MUSGO_DATA`, usa KV (durable).
//   - Si no, usa Cache API + memoria del isolate (funciona sin configurar nada).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const MAX_HISTORY = 120;
const LATEST_KEY = 'latest';
const HISTORY_KEY = 'history';
const CACHE_BASE = 'https://musgo.internal/';

// Respaldo en memoria del isolate (cuando no hay KV).
const mem = { latest: null, history: [] };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  });
}

// --- Capa de almacenamiento (KV si existe, si no Cache API + memoria) ---

async function storeGet(env, key) {
  if (env && env.MUSGO_DATA) {
    const v = await env.MUSGO_DATA.get(key);
    return v ? JSON.parse(v) : null;
  }
  const cache = caches.default;
  const res = await cache.match(CACHE_BASE + key);
  if (res) return res.json();
  return key === HISTORY_KEY ? mem.history : mem.latest;
}

async function storePut(env, key, value) {
  if (env && env.MUSGO_DATA) {
    await env.MUSGO_DATA.put(key, JSON.stringify(value));
    return;
  }
  if (key === HISTORY_KEY) mem.history = value; else mem.latest = value;
  const cache = caches.default;
  await cache.put(
    CACHE_BASE + key,
    new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
  );
}

// --- Validación de la lectura entrante ---

function normalizeReading(body) {
  if (typeof body !== 'object' || body === null) return null;
  const humidity = Number(body.humidity);
  const state = Number(body.state);
  if (!Number.isFinite(humidity)) return null;
  return {
    humidity: Math.max(0, Math.min(100, Math.round(humidity))),
    state: [0, 1, 2].includes(state) ? state : null,
    device: typeof body.device === 'string' ? body.device.slice(0, 32) : 'esp32',
    uptime: Number.isFinite(Number(body.ts)) ? Number(body.ts) : null, // millis() del ESP32
    ts: Date.now(), // timestamp real del servidor (epoch ms)
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (pathname === '/api/health') {
      return json({ ok: true, storage: env && env.MUSGO_DATA ? 'kv' : 'cache', time: Date.now() });
    }

    if (pathname === '/api/data' && request.method === 'GET') {
      const latest = await storeGet(env, LATEST_KEY);
      return json(latest || {});
    }

    if (pathname === '/api/data' && request.method === 'POST') {
      let raw;
      try {
        raw = await request.json();
      } catch {
        return json({ ok: false, error: 'JSON inválido' }, 400);
      }
      const reading = normalizeReading(raw);
      if (!reading) return json({ ok: false, error: 'Falta "humidity" numérico' }, 422);

      await storePut(env, LATEST_KEY, reading);

      const history = (await storeGet(env, HISTORY_KEY)) || [];
      history.push({ humidity: reading.humidity, state: reading.state, ts: reading.ts });
      while (history.length > MAX_HISTORY) history.shift();
      await storePut(env, HISTORY_KEY, history);

      return json({ ok: true, reading });
    }

    if (pathname === '/api/history' && request.method === 'GET') {
      const history = (await storeGet(env, HISTORY_KEY)) || [];
      return json({ count: history.length, items: history });
    }

    // Raíz: pequeña ayuda
    if (pathname === '/') {
      return json({
        service: 'musgo-esp32',
        endpoints: ['POST /api/data', 'GET /api/data', 'GET /api/history', 'GET /api/health'],
      });
    }

    return json({ ok: false, error: 'Not found' }, 404);
  },
};
