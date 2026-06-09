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

    // Raíz: sirve el dashboard visual
    if (pathname === '/' && request.method === 'GET') {
      return new Response(DASHBOARD_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
      });
    }

    return json({ ok: false, error: 'Not found' }, 404);
  },
};

// Dashboard servido en "/". Consume la API del mismo origen (sin CORS).
const DASHBOARD_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Musgo que respira — Monitor</title>
<style>
  :root{--bg:#0b1220;--fg:#e6f1ff;--muted:#8aa0b8}
  *{box-sizing:border-box}
  html,body{height:100%;margin:0;font-family:Inter,system-ui,Segoe UI,Arial;background:var(--bg);color:var(--fg);display:flex;align-items:center;justify-content:center}
  .card{width:380px;max-width:92vw;padding:24px;border-radius:18px;background:linear-gradient(180deg,#0a1622,#0f2333);box-shadow:0 10px 40px rgba(0,0,0,.6)}
  .head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px}
  .title{font-weight:700;font-size:16px}
  .sub{color:var(--muted);font-size:12px;margin-top:2px}
  .status{font-size:12px;display:flex;align-items:center;gap:6px}
  .pill{width:8px;height:8px;border-radius:50%;background:#666;transition:background .3s}
  .gauge{display:flex;flex-direction:column;align-items:center;margin:8px 0 18px}
  .orb{width:150px;height:150px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:radial-gradient(circle at 50% 40%,#1b3a2a,#0c1c16);position:relative;animation:breathe 5s ease-in-out infinite}
  @keyframes breathe{0%,100%{transform:scale(.96)}50%{transform:scale(1.04)}}
  .hum{font-size:46px;font-weight:800;line-height:1}
  .hum small{font-size:18px;color:var(--muted);font-weight:600}
  .estado{text-align:center;font-weight:700;letter-spacing:.5px;margin-top:4px;color:var(--muted)}
  .meta{display:flex;justify-content:space-between;color:var(--muted);font-size:12px;margin-top:14px}
  .spark{display:flex;align-items:flex-end;gap:2px;height:46px;margin-top:16px}
  .spark>div{flex:1;background:#274;border-radius:2px;min-height:2px;transition:height .3s}
  .foot{color:var(--muted);font-size:11px;margin-top:14px;text-align:center;word-break:break-all}
</style>
</head>
<body>
<div class="card">
  <div class="head">
    <div><div class="title">🌿 Musgo que respira</div><div class="sub">Monitor ESP32 · en vivo</div></div>
    <div class="status"><span id="pill" class="pill"></span><span id="status">conectando…</span></div>
  </div>
  <div class="gauge">
    <div id="orb" class="orb"><div class="hum"><span id="hum">--</span><small>%</small></div></div>
    <div id="estado" class="estado">esperando datos…</div>
  </div>
  <div class="spark" id="spark"></div>
  <div class="meta"><span>Última lectura</span><span id="ago">—</span></div>
  <div class="foot" id="foot"></div>
</div>
<script>
const ESTADOS=[{txt:'SECO',color:'#ff5a5f'},{txt:'MEDIO',color:'#ffb84d'},{txt:'HÚMEDO',color:'#4de37f'}];
const $=(id)=>document.getElementById(id);
let lastTs=0;
const colorFor=(h)=>h<30?ESTADOS[0]:h<60?ESTADOS[1]:ESTADOS[2];
function relTime(ms){const s=Math.round((Date.now()-ms)/1000);if(s<2)return'ahora';if(s<60)return'hace '+s+'s';return'hace '+Math.round(s/60)+' min'}
function setOnline(ok){$('status').textContent=ok?'en línea':'sin conexión';$('pill').style.background=ok?'#4de37f':'#ff5a5f'}
async function tick(){try{
  const r=await fetch('/api/data',{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);
  const j=await r.json();setOnline(true);
  if(j&&typeof j.humidity==='number'){
    const h=j.humidity,st=ESTADOS[j.state]||colorFor(h);
    $('hum').textContent=h;$('estado').textContent=st.txt;$('estado').style.color=st.color;
    $('orb').style.background='radial-gradient(circle at 50% 40%,'+st.color+'33,#0c1c16)';
    $('orb').style.boxShadow='0 0 30px 6px '+st.color+'55';
    lastTs=j.ts||Date.now();$('foot').textContent=(j.device||'esp32');
  }else{$('estado').textContent='sin lecturas todavía'}
}catch(e){setOnline(false);$('foot').textContent=String(e.message||e)}}
async function loadHistory(){try{
  const r=await fetch('/api/history',{cache:'no-store'});if(!r.ok)return;
  const d=await r.json(),items=d.items||[],spark=$('spark');spark.innerHTML='';
  items.slice(-40).forEach((it)=>{const b=document.createElement('div');b.style.height=Math.max(2,it.humidity)+'%';b.style.background=colorFor(it.humidity).color;spark.appendChild(b)});
}catch(e){}}
function refreshAgo(){if(lastTs)$('ago').textContent=relTime(lastTs)}
tick();loadHistory();setInterval(tick,1500);setInterval(loadHistory,5000);setInterval(refreshAgo,1000);
</script>
</body>
</html>`;
