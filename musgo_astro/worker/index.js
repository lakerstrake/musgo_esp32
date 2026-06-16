// Cloudflare Worker — API + dashboard del "Musgo que respira"
//
// Almacenamiento en dos capas:
//   - KV "MUSGO_DATA" (global, consistente entre datacenters): clave "latest".
//     Escritura throttled cada 15s para respetar la cuota gratis de KV (1000/dia).
//   - Cache API (por-datacenter, sin limite): da lecturas casi en vivo a quien
//     este en el mismo colo que el ESP32.
//   La lectura devuelve la mas reciente entre ambas capas.
//   El historico (sparkline) lo acumula el navegador desde sus propias lecturas.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const KV_WRITE_INTERVAL_MS = 15000; // throttle de escritura a KV
const CACHE_URL = 'https://musgo.internal/latest';

// Estado por-isolate: throttle de KV.
let lastKvWrite = 0;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  });
}

function normalizeReading(body) {
  if (typeof body !== 'object' || body === null) return null;
  const humidity = Number(body.humidity);
  const state = Number(body.state);
  if (!Number.isFinite(humidity)) return null;
  return {
    humidity: Math.max(0, Math.min(100, Math.round(humidity))),
    state: [0, 1, 2].includes(state) ? state : null,
    device: typeof body.device === 'string' ? body.device.slice(0, 32) : 'esp32',
    uptime: Number.isFinite(Number(body.ts)) ? Number(body.ts) : null,
    ts: Date.now(),
  };
}

async function cacheGet() {
  try {
    const res = await caches.default.match(CACHE_URL);
    return res ? await res.json() : null;
  } catch { return null; }
}

async function cachePut(reading) {
  try {
    await caches.default.put(
      CACHE_URL,
      new Response(JSON.stringify(reading), { headers: { 'Content-Type': 'application/json' } })
    );
  } catch { /* best-effort */ }
}

async function kvGet(env) {
  if (!env.MUSGO_DATA) return null;
  try { const v = await env.MUSGO_DATA.get('latest'); return v ? JSON.parse(v) : null; }
  catch { return null; }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (pathname === '/api/health') {
      return json({ ok: true, storage: env.MUSGO_DATA ? 'kv' : 'cache', time: Date.now() });
    }

    if (pathname === '/api/data' && request.method === 'POST') {
      let raw;
      try { raw = await request.json(); }
      catch { return json({ ok: false, error: 'JSON inválido' }, 400); }
      const reading = normalizeReading(raw);
      if (!reading) return json({ ok: false, error: 'Falta "humidity" numérico' }, 422);

      // Capa viva (cada POST) + capa global (throttled).
      await cachePut(reading);
      let wroteKv = false;
      if (env.MUSGO_DATA && Date.now() - lastKvWrite > KV_WRITE_INTERVAL_MS) {
        lastKvWrite = Date.now();
        try { await env.MUSGO_DATA.put('latest', JSON.stringify(reading)); wroteKv = true; }
        catch { /* si se excede cuota, seguimos sirviendo desde cache */ }
      }
      return json({ ok: true, kv: wroteKv, reading });
    }

    if (pathname === '/api/data' && request.method === 'GET') {
      const [c, k] = await Promise.all([cacheGet(), kvGet(env)]);
      // Devuelve la lectura mas reciente entre cache (colo) y KV (global).
      const latest = [c, k].filter(Boolean).sort((a, b) => (b.ts || 0) - (a.ts || 0))[0] || {};
      return json(latest);
    }

    // Historico minimo (el navegador construye su propia serie). Mantiene compatibilidad.
    if (pathname === '/api/history' && request.method === 'GET') {
      const latest = (await cacheGet()) || (await kvGet(env));
      return json({ count: latest ? 1 : 0, items: latest ? [{ humidity: latest.humidity, state: latest.state, ts: latest.ts }] : [] });
    }

    if (pathname === '/' && request.method === 'GET') {
      return new Response(DASHBOARD_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
      });
    }

    return json({ ok: false, error: 'Not found' }, 404);
  },
};

// Dashboard servido en "/". Consume la API del mismo origen (sin CORS).
// El sparkline se acumula en el navegador a partir de cada lectura.
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
let lastTs=0;const hist=[];
const colorFor=(h)=>h<30?ESTADOS[0]:h<60?ESTADOS[1]:ESTADOS[2];
function relTime(ms){const s=Math.round((Date.now()-ms)/1000);if(s<2)return'ahora';if(s<60)return'hace '+s+'s';return'hace '+Math.round(s/60)+' min'}
function setOnline(ok){$('status').textContent=ok?'en línea':'sin conexión';$('pill').style.background=ok?'#4de37f':'#ff5a5f'}
function drawSpark(){const spark=$('spark');spark.innerHTML='';hist.slice(-40).forEach((h)=>{const b=document.createElement('div');b.style.height=Math.max(2,h)+'%';b.style.background=colorFor(h).color;spark.appendChild(b)})}
async function tick(){try{
  const r=await fetch('/api/data',{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);
  const j=await r.json();setOnline(true);
  if(j&&typeof j.humidity==='number'){
    const h=j.humidity,st=ESTADOS[j.state]||colorFor(h);
    $('hum').textContent=h;$('estado').textContent=st.txt;$('estado').style.color=st.color;
    $('orb').style.background='radial-gradient(circle at 50% 40%,'+st.color+'33,#0c1c16)';
    $('orb').style.boxShadow='0 0 30px 6px '+st.color+'55';
    if(j.ts!==lastTs){lastTs=j.ts||Date.now();hist.push(h);if(hist.length>120)hist.shift();drawSpark()}
    $('foot').textContent=(j.device||'esp32');
  }else{$('estado').textContent='sin lecturas todavía'}
}catch(e){setOnline(false);$('foot').textContent=String(e.message||e)}}
function refreshAgo(){if(lastTs)$('ago').textContent=relTime(lastTs)}
tick();setInterval(tick,1500);setInterval(refreshAgo,1000);
</script>
</body>
</html>`;
