// Cloudflare Worker — API + dashboard del "Musgo que respira"
//
// Almacenamiento en dos capas:
//   - KV "MUSGO_DATA" (global, consistente entre datacenters): clave "latest".
//     Escritura throttled cada 15s para respetar la cuota gratis de KV (1000/dia).
//   - Cache API (por-datacenter, sin limite): lecturas casi en vivo en el mismo colo.
//   La lectura devuelve la mas reciente entre ambas capas.
//   El historico (sparkline) lo acumula el navegador desde sus propias lecturas.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const KV_WRITE_INTERVAL_MS = 15000;
const CACHE_URL = 'https://musgo.internal/latest';

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
      const latest = [c, k].filter(Boolean).sort((a, b) => (b.ts || 0) - (a.ts || 0))[0] || {};
      return json(latest);
    }

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

// =================== Dashboard (servido en "/") ===================
// Sin backticks ni ${} dentro: este texto vive en un template literal del Worker.
const DASHBOARD_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Musgo que respira — Monitor IoT</title>
<style>
  :root{
    --bg:#0b0f14; --panel:#11161d; --panel2:#0e131a; --line:#1e2630;
    --fg:#e6edf3; --muted:#8b98a5; --accent:#3fb950;
    --seco:#f0594b; --medio:#e3a23c; --humedo:#3fb950;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:radial-gradient(120% 80% at 50% -10%,#11202a,#0b0f14 60%);color:var(--fg);
    min-height:100%;display:flex;align-items:flex-start;justify-content:center;padding:28px 16px}
  .app{width:100%;max-width:460px}
  header{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
  .brand{display:flex;align-items:center;gap:10px}
  .logo{width:34px;height:34px;border-radius:10px;background:linear-gradient(145deg,#173a28,#0e1f17);display:flex;align-items:center;justify-content:center;font-size:18px;border:1px solid var(--line)}
  .brand h1{font-size:16px;font-weight:650;letter-spacing:.2px}
  .brand p{font-size:11.5px;color:var(--muted);margin-top:1px}
  .live{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted);border:1px solid var(--line);padding:6px 10px;border-radius:999px;background:var(--panel)}
  .dot{width:8px;height:8px;border-radius:50%;background:#5a6675;transition:.3s}
  nav{display:flex;gap:4px;background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:4px;margin-bottom:16px}
  nav button{flex:1;border:0;background:transparent;color:var(--muted);font:inherit;font-size:13px;font-weight:550;padding:9px;border-radius:9px;cursor:pointer;transition:.15s}
  nav button.on{background:var(--panel);color:var(--fg);box-shadow:0 1px 0 rgba(255,255,255,.03)}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:22px}
  /* Monitor */
  .gauge{display:flex;flex-direction:column;align-items:center;padding:8px 0 6px}
  .orb{width:160px;height:160px;border-radius:50%;display:flex;align-items:center;justify-content:center;
    background:radial-gradient(circle at 50% 38%,#16321f,#0b1812);position:relative;animation:breathe 5s ease-in-out infinite}
  @keyframes breathe{0%,100%{transform:scale(.95)}50%{transform:scale(1.05)}}
  .hum{font-size:52px;font-weight:750;line-height:1}
  .hum small{font-size:20px;color:var(--muted);font-weight:600}
  .estado{margin-top:12px;font-weight:700;letter-spacing:1px;font-size:15px;color:var(--muted)}
  .spark{display:flex;align-items:flex-end;gap:2px;height:50px;margin:18px 0 4px}
  .spark>div{flex:1;background:#26323f;border-radius:2px;min-height:2px;transition:height .4s}
  .meta{display:flex;justify-content:space-between;color:var(--muted);font-size:12px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
  .legend{display:flex;gap:8px;margin-top:14px}
  .chip{flex:1;text-align:center;font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:9px;padding:8px 4px}
  .chip b{display:block;font-size:12px;margin-bottom:2px}
  /* Info */
  .info h2{font-size:14px;margin:18px 0 8px;display:flex;align-items:center;gap:8px}
  .info h2:first-child{margin-top:2px}
  .info p{font-size:13.5px;line-height:1.6;color:#c9d4de}
  .flow{list-style:none;counter-reset:s;margin:6px 0}
  .flow li{counter-increment:s;position:relative;padding:8px 0 8px 34px;font-size:13px;line-height:1.5;color:#c9d4de;border-bottom:1px solid var(--line)}
  .flow li:last-child{border-bottom:0}
  .flow li::before{content:counter(s);position:absolute;left:0;top:7px;width:22px;height:22px;border-radius:50%;background:var(--panel2);border:1px solid var(--line);color:var(--accent);font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center}
  table{width:100%;border-collapse:collapse;margin-top:4px;font-size:12.5px}
  th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
  td b{color:var(--fg)}
  .tag{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:middle}
  .tech{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
  .tech span{font-size:11.5px;color:#c9d4de;background:var(--panel2);border:1px solid var(--line);border-radius:7px;padding:5px 9px}
  footer{margin-top:18px;text-align:center;color:var(--muted);font-size:12px;line-height:1.7}
  footer b{color:var(--fg);font-weight:600}
  .hidden{display:none}
</style>
</head>
<body>
<div class="app">
  <header>
    <div class="brand">
      <div class="logo">🌿</div>
      <div><h1>Musgo que respira</h1><p>Monitoreo IoT en tiempo real</p></div>
    </div>
    <div class="live"><span id="dot" class="dot"></span><span id="status">conectando…</span></div>
  </header>

  <nav>
    <button id="tabMon" class="on" onclick="ver('mon')">Monitor</button>
    <button id="tabInfo" onclick="ver('info')">Cómo funciona</button>
  </nav>

  <!-- ===== Monitor ===== -->
  <section id="mon" class="card">
    <div class="gauge">
      <div id="orb" class="orb"><div class="hum"><span id="val">--</span><small>%</small></div></div>
      <div id="estado" class="estado">esperando datos…</div>
    </div>
    <div class="spark" id="spark"></div>
    <div class="meta"><span>Última lectura</span><span id="ago">—</span></div>
    <div class="legend">
      <div class="chip" style="border-color:#3a2420"><b style="color:var(--seco)">SECO</b>&lt; 30 %</div>
      <div class="chip" style="border-color:#3a3120"><b style="color:var(--medio)">MEDIO</b>30 – 60 %</div>
      <div class="chip" style="border-color:#20381f"><b style="color:var(--humedo)">HÚMEDO</b>&gt; 60 %</div>
    </div>
  </section>

  <!-- ===== Cómo funciona ===== -->
  <section id="info" class="card info hidden">
    <h2>🌱 ¿Qué es?</h2>
    <p><b>Musgo que respira</b> es una instalación que le da “voz” a una planta de musgo. Un sensor mide cuánta agua tiene el musgo y, según eso, la obra <b>cambia de color, emite sonidos</b> y muestra su estado <b>en vivo por internet</b> en este panel. Así cualquiera puede saber, de un vistazo, cómo se siente el musgo.</p>

    <h2>⚙️ ¿Cómo funciona?</h2>
    <ol class="flow">
      <li>Un <b>sensor de humedad</b> mide el agua en el musgo cada fracción de segundo.</li>
      <li>Una placa <b>ESP32</b> convierte esa medida en un porcentaje (0–100 %) y decide el estado.</li>
      <li>El ESP32 lo envía por <b>WiFi</b> a un servidor en la nube (<b>Cloudflare Worker</b>) cada 2 segundos.</li>
      <li>El servidor guarda la última lectura y la comparte de forma global.</li>
      <li>Este <b>panel</b> la pide y se actualiza solo, sin recargar la página.</li>
    </ol>

    <h2>🎨🔊 Estados, color y sonido</h2>
    <table>
      <tr><th>Estado</th><th>LED</th><th>Sonido</th></tr>
      <tr>
        <td><span class="tag" style="background:var(--humedo)"></span><b>Húmedo</b><br>&gt; 60 %</td>
        <td>Verde</td>
        <td>Casi en silencio. Cada cierto tiempo un <b>“check”</b> suave que confirma que está bien.</td>
      </tr>
      <tr>
        <td><span class="tag" style="background:var(--medio)"></span><b>Medio</b><br>30–60 %</td>
        <td>Ámbar</td>
        <td><b>Alerta media</b>: doble tono de atención repetido cada ~12 s.</td>
      </tr>
      <tr>
        <td><span class="tag" style="background:var(--seco)"></span><b>Seco</b><br>&lt; 30 %</td>
        <td>Rojo</td>
        <td><b>Súper alerta</b>: ráfaga aguda y ascendente, insistente cada ~4 s. ¡Necesita agua!</td>
      </tr>
    </table>
    <p style="margin-top:10px">Cada vez que <b>cambia de estado</b>, suena primero un “ding-dong” identificador para avisar el cambio, y luego la alerta del nuevo estado.</p>

    <h2>🧩 Tecnología</h2>
    <div class="tech">
      <span>ESP32</span><span>Sensor de humedad</span><span>LED RGB</span><span>Buzzer</span>
      <span>Cloudflare Workers</span><span>KV (nube)</span><span>HTTPS</span><span>HTML/JS</span>
    </div>
  </section>

  <footer>
    Hecho por <b>Andrés Camilo Lagos Monroy</b> &amp; <b>Juan Manuel Lagos Monroy</b><br>
    Proyecto de monitoreo IoT · Musgo que respira 🌿
  </footer>
</div>

<script>
var ESTADOS=[{txt:'SECO',color:'#f0594b'},{txt:'MEDIO',color:'#e3a23c'},{txt:'HÚMEDO',color:'#3fb950'}];
function $(id){return document.getElementById(id)}
var lastTs=0, hist=[];
function colorFor(h){return h<30?ESTADOS[0]:h<60?ESTADOS[1]:ESTADOS[2]}
function relTime(ms){var s=Math.round((Date.now()-ms)/1000);if(s<2)return'ahora';if(s<60)return'hace '+s+'s';return'hace '+Math.round(s/60)+' min'}
function setOnline(ok){$('status').textContent=ok?'en línea':'sin conexión';$('dot').style.background=ok?'#3fb950':'#f0594b'}
function ver(t){
  var mon=t==='mon';
  $('mon').classList.toggle('hidden',!mon);$('info').classList.toggle('hidden',mon);
  $('tabMon').classList.toggle('on',mon);$('tabInfo').classList.toggle('on',!mon);
}
function drawSpark(){var s=$('spark');s.innerHTML='';hist.slice(-44).forEach(function(h){var b=document.createElement('div');b.style.height=Math.max(2,h)+'%';b.style.background=colorFor(h).color;s.appendChild(b)})}
function tick(){
  fetch('/api/data',{cache:'no-store'}).then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(j){
    setOnline(true);
    if(j&&typeof j.humidity==='number'){
      var h=j.humidity, st=ESTADOS[j.state]||colorFor(h);
      $('val').textContent=h;$('estado').textContent=st.txt;$('estado').style.color=st.color;
      $('orb').style.background='radial-gradient(circle at 50% 38%,'+st.color+'2e,#0b1812)';
      $('orb').style.boxShadow='0 0 34px 6px '+st.color+'55';
      if(j.ts!==lastTs){lastTs=j.ts||Date.now();hist.push(h);if(hist.length>140)hist.shift();drawSpark()}
    }else{$('estado').textContent='sin lecturas todavía'}
  }).catch(function(){setOnline(false)});
}
function refreshAgo(){if(lastTs)$('ago').textContent=relTime(lastTs)}
tick();setInterval(tick,1500);setInterval(refreshAgo,1000);
</script>
</body>
</html>`;
