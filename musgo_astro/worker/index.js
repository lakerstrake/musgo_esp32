// Cloudflare Worker — API + dashboard del "Musgo que respira"
//
// Almacenamiento:
//   - Cache API: telemetria (latest + history) -> sin gastar cuota de KV.
//   - KV "MUSGO_DATA": solo la calibracion (config), se escribe poquisimas veces.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const HISTORY_MIN_GAP_MS = 3000;
const MAX_HISTORY = 240;
const CACHE_BASE = 'https://musgo.internal/';
const DEFAULT_CONFIG = { dryRaw: 2515, wetRaw: 1128 };

let memHistory = null;
let cfgCache = null, cfgCacheT = 0;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  });
}

function normalizeReading(body) {
  if (typeof body !== 'object' || body === null) return null;
  const humidity = Number(body.humidity);
  if (!Number.isFinite(humidity)) return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  const f1 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : null);
  const state = Number(body.state);
  return {
    humidity: Math.max(0, Math.min(100, Math.round(humidity))),
    state: [0, 1, 2].includes(state) ? state : null,
    raw: num(body.raw),
    rssi: num(body.rssi),
    tempSi: f1(body.tempSi),        // °C (Si7021)
    tempBmp: f1(body.tempBmp),      // °C (BMP280/BME280)
    pressure: f1(body.pressure),    // hPa (BMP280)
    airHum: num(body.airHum),       // % humedad del aire (Si7021/BME280)
    device: typeof body.device === 'string' ? body.device.slice(0, 32) : 'esp32',
    uptime: num(body.ts),
    ts: Date.now(),
  };
}

async function cacheGetKey(key) {
  try { const r = await caches.default.match(CACHE_BASE + key); return r ? await r.json() : null; }
  catch { return null; }
}
async function cachePutKey(key, val) {
  try {
    await caches.default.put(CACHE_BASE + key,
      new Response(JSON.stringify(val), { headers: { 'Content-Type': 'application/json' } }));
  } catch { /* best-effort */ }
}

async function getConfig(env) {
  if (cfgCache && Date.now() - cfgCacheT < 60000) return cfgCache;
  let cfg = { ...DEFAULT_CONFIG };
  if (env.MUSGO_DATA) {
    try { const v = await env.MUSGO_DATA.get('config'); if (v) cfg = { ...DEFAULT_CONFIG, ...JSON.parse(v) }; }
    catch { /* default */ }
  }
  cfgCache = cfg; cfgCacheT = Date.now();
  return cfg;
}
async function setConfig(env, cfg) {
  cfgCache = cfg; cfgCacheT = Date.now();
  if (env.MUSGO_DATA) { try { await env.MUSGO_DATA.put('config', JSON.stringify(cfg)); } catch { /* */ } }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (pathname === '/api/health') {
      return json({ ok: true, storage: 'cache', config: env.MUSGO_DATA ? 'kv' : 'mem', time: Date.now() });
    }

    if (pathname === '/api/config') {
      if (request.method === 'GET') return json(await getConfig(env));
      if (request.method === 'POST') {
        let raw; try { raw = await request.json(); } catch { return json({ ok: false, error: 'JSON inválido' }, 400); }
        const dryRaw = Math.round(Number(raw.dryRaw));
        const wetRaw = Math.round(Number(raw.wetRaw));
        const inRange = (n) => Number.isFinite(n) && n >= 0 && n <= 4095;
        if (!inRange(dryRaw) || !inRange(wetRaw)) return json({ ok: false, error: 'Valores fuera de rango (0–4095)' }, 422);
        if (Math.abs(dryRaw - wetRaw) < 200) return json({ ok: false, error: 'Seco y húmedo deben diferir bastante (≥200).' }, 422);
        const cfg = { dryRaw, wetRaw };
        await setConfig(env, cfg);
        return json({ ok: true, config: cfg });
      }
    }

    if (pathname === '/api/data' && request.method === 'POST') {
      let raw; try { raw = await request.json(); } catch { return json({ ok: false, error: 'JSON inválido' }, 400); }
      const reading = normalizeReading(raw);
      if (!reading) return json({ ok: false, error: 'Falta "humidity" numérico' }, 422);

      await cachePutKey('latest', reading);

      if (memHistory === null) { memHistory = (await cacheGetKey('history')) || []; }
      const last = memHistory[memHistory.length - 1];
      if (!last || reading.ts - (last.ts || 0) >= HISTORY_MIN_GAP_MS) {
        memHistory.push({ ts: reading.ts, humidity: reading.humidity, tempSi: reading.tempSi, tempBmp: reading.tempBmp, pressure: reading.pressure, airHum: reading.airHum });
        while (memHistory.length > MAX_HISTORY) memHistory.shift();
        await cachePutKey('history', memHistory);
      }
      return json({ ok: true, config: await getConfig(env) });
    }

    if (pathname === '/api/data' && request.method === 'GET') {
      return json((await cacheGetKey('latest')) || {});
    }

    if (pathname === '/api/history' && request.method === 'GET') {
      const items = (memHistory !== null) ? memHistory : ((await cacheGetKey('history')) || []);
      return json({ count: items.length, items });
    }

    if (pathname === '/' && request.method === 'GET') {
      return new Response(DASHBOARD_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
      });
    }

    return json({ ok: false, error: 'Not found' }, 404);
  },
};

// =================== Dashboard (una pestaña por sensor) ===================
const DASHBOARD_HTML = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Musgo que respira — Monitor IoT</title>
<style>
  :root{--bg:#0b0f14;--panel:#11161d;--panel2:#0e131a;--line:#1e2630;--fg:#e6edf3;--muted:#8b98a5;
    --seco:#f0594b;--medio:#e3a23c;--humedo:#3fb950}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:radial-gradient(120% 80% at 50% -10%,#11202a,#0b0f14 60%);color:var(--fg);min-height:100vh;display:flex;justify-content:center;padding:26px 16px}
  .app{width:100%;max-width:460px}
  header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
  .brand{display:flex;align-items:center;gap:10px}
  .logo{width:34px;height:34px;border-radius:10px;background:linear-gradient(145deg,#173a28,#0e1f17);display:flex;align-items:center;justify-content:center;font-size:18px;border:1px solid var(--line)}
  .brand h1{font-size:16px;font-weight:650}
  .brand p{font-size:11.5px;color:var(--muted);margin-top:1px}
  .live{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted);border:1px solid var(--line);padding:6px 10px;border-radius:999px;background:var(--panel)}
  .dot{width:8px;height:8px;border-radius:50%;background:#5a6675;transition:.3s}
  nav{display:flex;gap:4px;background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:4px;margin-bottom:16px}
  nav button{flex:1;border:0;background:transparent;color:var(--muted);font:inherit;font-size:12.5px;font-weight:550;padding:9px 4px;border-radius:9px;cursor:pointer;transition:.15s}
  nav button.on{background:var(--panel);color:var(--fg)}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:20px}
  .gauge{display:flex;flex-direction:column;align-items:center;padding:6px 0 4px}
  .orb{width:158px;height:158px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:radial-gradient(circle at 50% 38%,#16321f,#0b1812);animation:breathe 5s ease-in-out infinite}
  @keyframes breathe{0%,100%{transform:scale(.95)}50%{transform:scale(1.05)}}
  .hum{font-size:50px;font-weight:750;line-height:1}
  .hum small{font-size:20px;color:var(--muted);font-weight:600}
  .estado{margin-top:12px;font-weight:700;letter-spacing:1px;font-size:15px;color:var(--muted)}
  .sub{margin-top:6px;font-size:11.5px;color:var(--muted)}
  .spark{display:flex;align-items:flex-end;gap:2px;height:42px;margin:16px 0 4px}
  .spark>div{flex:1;background:#26323f;border-radius:2px;min-height:2px;transition:height .35s}
  .meta{display:flex;justify-content:space-between;color:var(--muted);font-size:12px;margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}
  .metric{background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px}
  .metric:last-child{margin-bottom:0}
  .mhead{display:flex;justify-content:space-between;align-items:baseline;font-size:13px;color:#c9d4de;margin-bottom:8px}
  .mhead b{font-size:24px;color:var(--fg);font-weight:750}
  .chart{width:100%;height:48px;display:block;overflow:visible}
  .chartrange{display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-top:5px}
  .src{font-size:11px;color:var(--muted);text-align:center;margin-top:4px}
  details{margin-top:14px;border-top:1px solid var(--line);padding-top:12px}
  summary{cursor:pointer;font-size:13px;font-weight:600;color:#c9d4de;list-style:none}
  summary::-webkit-details-marker{display:none}
  summary::before{content:'⚙️ '}
  .hint{font-size:12px;line-height:1.5;color:#c9d4de;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:11px;margin:12px 0}
  .ro2{display:flex;gap:10px;margin:10px 0}
  .ro2 .b{flex:1;text-align:center;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:10px}
  .ro2 span{display:block;font-size:11px;color:var(--muted)}
  .ro2 b{font-size:22px}
  .row{margin:10px 0}
  .row label{display:block;font-size:12px;color:#c9d4de;margin-bottom:6px}
  .ctl{display:flex;gap:8px}
  .ctl input{flex:1;min-width:0;background:var(--panel2);border:1px solid var(--line);color:var(--fg);border-radius:9px;padding:10px;font:inherit}
  .ctl button,.save{border:1px solid var(--line);background:var(--panel2);color:var(--fg);font:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:0 12px;cursor:pointer;white-space:nowrap}
  .save{width:100%;padding:11px;margin-top:8px;background:var(--humedo);color:#06210f;border-color:transparent}
  .msg{font-size:12px;text-align:center;margin-top:8px;min-height:15px}
  .info h2{font-size:14px;margin:16px 0 7px}
  .info h2:first-child{margin-top:0}
  .info p{font-size:13px;line-height:1.6;color:#c9d4de}
  .subnav{display:flex;gap:4px;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:3px;margin-bottom:14px}
  .subnav button{flex:1;border:0;background:transparent;color:var(--muted);font:inherit;font-size:12px;font-weight:550;padding:7px;border-radius:8px;cursor:pointer}
  .subnav button.on{background:var(--panel);color:var(--fg)}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase}
  code{font-family:ui-monospace,Consolas,monospace;font-size:11px;background:var(--panel2);border:1px solid var(--line);border-radius:5px;padding:1px 5px;color:#c9d4de}
  .schem{font-family:ui-monospace,Consolas,monospace;font-size:10px;line-height:1.4;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:12px;color:#c9d4de;overflow-x:auto;white-space:pre;margin:4px 0}
  footer{margin-top:16px;text-align:center;color:var(--muted);font-size:12px;line-height:1.7}
  footer b{color:var(--fg);font-weight:600}
  .hidden{display:none}
</style>
</head>
<body>
<div class="app">
  <header>
    <div class="brand"><div class="logo">🌿</div><div><h1>Musgo que respira</h1><p>Monitoreo IoT en tiempo real</p></div></div>
    <div class="live"><span id="dot" class="dot"></span><span id="status">conectando…</span></div>
  </header>

  <nav>
    <button id="tMusgo" class="on" onclick="ver('musgo')">🌱 Musgo</button>
    <button id="tAire" onclick="ver('aire')">💨 Aire</button>
    <button id="tAmb" onclick="ver('amb')">🌡️ Ambiente</button>
    <button id="tInfo" onclick="ver('info')">ℹ️ Info</button>
  </nav>

  <!-- ===== Musgo (sensor de suelo) ===== -->
  <section id="musgo" class="card">
    <div class="gauge">
      <div id="orb" class="orb"><div class="hum"><span id="val">--</span><small>%</small></div></div>
      <div id="estado" class="estado">esperando datos…</div>
      <div class="sub" id="subline"></div>
    </div>
    <div class="spark" id="spark"></div>
    <div class="chartrange"><span id="rMusgoA">—</span><span id="rMusgoB">—</span></div>
    <details>
      <summary>Calibrar el sensor del musgo</summary>
      <div class="hint">Con el musgo <b>seco</b> pulsa “Capturar” en SECO; riégalo y pulsa “Capturar” en HÚMEDO; luego Guardar.</div>
      <div class="ro2">
        <div class="b"><span>Lectura ADC</span><b id="rawNow">—</b></div>
        <div class="b"><span>Humedad</span><b id="humNow">—</b></div>
      </div>
      <div class="row"><label><b>SECO</b> · ADC con musgo seco</label><div class="ctl"><input id="inSeco" type="number" inputmode="numeric"/><button onclick="capturar('inSeco')">Capturar</button></div></div>
      <div class="row"><label><b>HÚMEDO</b> · ADC con musgo mojado</label><div class="ctl"><input id="inHumedo" type="number" inputmode="numeric"/><button onclick="capturar('inHumedo')">Capturar</button></div></div>
      <button class="save" onclick="guardar()">Guardar calibración</button>
      <div id="msg" class="msg"></div>
    </details>
    <div class="meta"><span id="devLabel">—</span><span id="ago">—</span></div>
  </section>

  <!-- ===== Aire (Si7021) ===== -->
  <section id="aire" class="card hidden">
    <div class="metric">
      <div class="mhead"><span>🌡️ Temperatura</span><b id="aTemp">—</b></div>
      <svg class="chart" id="chTsi" viewBox="0 0 300 56" preserveAspectRatio="none"></svg>
      <div class="chartrange"><span id="rTsiA">—</span><span id="rTsiB">—</span></div>
    </div>
    <div class="metric">
      <div class="mhead"><span>💨 Humedad del aire</span><b id="aHum">—</b></div>
      <svg class="chart" id="chAir" viewBox="0 0 300 56" preserveAspectRatio="none"></svg>
      <div class="chartrange"><span id="rAirA">—</span><span id="rAirB">—</span></div>
    </div>
    <div class="src">Sensor de aire (<b>Si7021/HTU21D</b>) · si dice “—”, no detectado</div>
  </section>

  <!-- ===== Ambiente (BMP280) ===== -->
  <section id="amb" class="card hidden">
    <div class="metric">
      <div class="mhead"><span>🌡️ Temperatura</span><b id="bTemp">—</b></div>
      <svg class="chart" id="chTbmp" viewBox="0 0 300 56" preserveAspectRatio="none"></svg>
      <div class="chartrange"><span id="rTbA">—</span><span id="rTbB">—</span></div>
    </div>
    <div class="metric">
      <div class="mhead"><span>⏱️ Presión</span><b id="bPres">—</b></div>
      <svg class="chart" id="chPres" viewBox="0 0 300 56" preserveAspectRatio="none"></svg>
      <div class="chartrange"><span id="rPresA">—</span><span id="rPresB">—</span></div>
    </div>
    <div class="src">Sensor <b>BMP280</b> · si dice “—”, no está detectado</div>
  </section>

  <!-- ===== Info ===== -->
  <section id="info" class="card info hidden">
    <div class="subnav">
      <button id="subBas" class="on" onclick="nivel('bas')">Explicación básica</button>
      <button id="subTec" onclick="nivel('tec')">Explicación técnica</button>
    </div>
    <div id="infoBasica">
      <h2>🌱 ¿Qué es?</h2>
      <p><b>Musgo que respira</b> le da “voz” a un musgo. Cada caja de Petri tiene su sensor y su LED. El musgo cambia de <b>color</b> y <b>sonido</b> según su humedad, y todo se ve <b>en vivo</b> aquí.</p>
      <h2>🔬 Cada sensor</h2>
      <table>
        <tr><th>Pestaña</th><th>Mide</th></tr>
        <tr><td><b>🌱 Musgo</b></td><td>Humedad del sustrato (sensor de suelo)</td></tr>
        <tr><td><b>💨 Aire</b></td><td>Temperatura + humedad del aire (Si7021)</td></tr>
        <tr><td><b>🌡️ Ambiente</b></td><td>Temperatura + presión (BMP280)</td></tr>
      </table>
      <h2>🎨🔊 Musgo: color y sonido</h2>
      <table>
        <tr><th>Estado</th><th>LED / Sonido</th></tr>
        <tr><td><b>Húmedo</b> &gt;60%</td><td>Verde · toca la Marcha Imperial 🎵</td></tr>
        <tr><td><b>Medio</b> 30–60%</td><td>Ámbar · alerta media</td></tr>
        <tr><td><b>Seco</b> &lt;30%</td><td>Rojo · súper alerta</td></tr>
      </table>
    </div>
    <div id="infoTecnica" class="hidden">
      <h2>🏗️ Arquitectura</h2>
      <p>Un <b>Cloudflare Worker</b> (serverless, edge) sirve esta web (<code>/</code>) y la API (<code>/api/*</code>). Telemetría en <b>Cache API</b>; calibración en <b>KV</b>.</p>
      <h2>🔁 Flujo</h2>
      <p>ESP32 lee cada sensor por separado → <b>HTTPS POST</b> <code>/api/data</code> cada 2 s con <code>{humidity, tempSi, airHum, tempBmp, pressure, ...}</code> → la web hace <code>fetch</code> cada 1 s.</p>
      <h2>🔌 Conexiones</h2>
<pre class="schem">  Musgo AOUT ─ D34        RGB1 ─ D25/26/14 (musgo)
  RGB2 ─ D2/4/16 (aire)   Bicolor ─ D5/18 (temp)
  Buzzer S ─ D22          I2C ─ D19/D21
  (BMP280 0x76 + Si7021 0x40)   comunes ─ GND</pre>
      <p>Esquemático completo en <code>CONEXIONES.md</code>.</p>
    </div>
  </section>

  <footer>Hecho por <b>Andrés Camilo Lagos Monroy</b> &amp; <b>Juan Manuel Lagos Monroy</b><br>Musgo que respira 🌿</footer>
</div>

<script>
var ESTADOS=[{txt:'SECO',color:'#f0594b'},{txt:'MEDIO',color:'#e3a23c'},{txt:'HÚMEDO',color:'#3fb950'}];
function $(id){return document.getElementById(id)}
var lastTs=0, currentRaw=null, sparkData=[];
var live={hum:[],tsi:[],air:[],tbmp:[],pres:[]}, LMAX=120;
function isNum(v){return typeof v==='number'}
function colorFor(h){return h<30?ESTADOS[0]:h<60?ESTADOS[1]:ESTADOS[2]}
function relTime(ms){var s=Math.round((Date.now()-ms)/1000);if(s<2)return'ahora';if(s<60)return'hace '+s+'s';return'hace '+Math.round(s/60)+' min'}
function setOnline(ok){$('status').textContent=ok?'en línea':'sin conexión';$('dot').style.background=ok?'#3fb950':'#f0594b'}
function setVal(id,v,u,d){var e=$(id);if(e)e.textContent=isNum(v)?((d?v.toFixed(d):Math.round(v))+u):'—'}
function ver(t){
  ['musgo','aire','amb','info'].forEach(function(s){$(s).classList.toggle('hidden',s!==t)});
  $('tMusgo').classList.toggle('on',t==='musgo');$('tAire').classList.toggle('on',t==='aire');
  $('tAmb').classList.toggle('on',t==='amb');$('tInfo').classList.toggle('on',t==='info');
  if(t==='info')nivel('bas'); else drawCharts();
}
function nivel(t){$('infoBasica').classList.toggle('hidden',t!=='bas');$('infoTecnica').classList.toggle('hidden',t!=='tec');
  $('subBas').classList.toggle('on',t==='bas');$('subTec').classList.toggle('on',t==='tec')}
function drawSpark(){var s=$('spark');s.innerHTML='';sparkData.slice(-44).forEach(function(h){var b=document.createElement('div');b.style.height=Math.max(2,h)+'%';b.style.background=colorFor(h).color;s.appendChild(b)})}
function drawChart(id,vals,color){
  var el=$(id);if(!el)return null;
  var pts=[];for(var i=0;i<vals.length;i++){if(isNum(vals[i]))pts.push(vals[i])}
  if(pts.length<2){el.innerHTML='';return null}
  var mn=Math.min.apply(null,pts),mx=Math.max.apply(null,pts),rg=(mx-mn)||1,n=pts.length,d='';
  for(var k=0;k<n;k++){var x=(k/(n-1))*300,y=56-4-((pts[k]-mn)/rg)*48;d+=(k?'L':'M')+x.toFixed(1)+' '+y.toFixed(1)+' '}
  el.innerHTML='<path d="'+d+'L300 56 L0 56 Z" fill="'+color+'22"/><path d="'+d+'" fill="none" stroke="'+color+'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
  return {min:mn,max:mx,last:pts[pts.length-1]};
}
function rng(a,b,r,suf,dec){ if(r){$(a).textContent='mín '+(dec?r.min.toFixed(dec):Math.round(r.min))+suf;$(b).textContent='máx '+(dec?r.max.toFixed(dec):Math.round(r.max))+suf}else{$(a).textContent='—';$(b).textContent=''} }
function drawCharts(){
  if(sparkData.length>1){var mn=Math.min.apply(null,sparkData),mx=Math.max.apply(null,sparkData);$('rMusgoA').textContent='mín '+mn+'%';$('rMusgoB').textContent='máx '+mx+'%'}
  rng('rTsiA','rTsiB',drawChart('chTsi',live.tsi,'#e3a23c'),'°',1);
  rng('rAirA','rAirB',drawChart('chAir',live.air,'#5fd0d6'),'%',0);
  rng('rTbA','rTbB',drawChart('chTbmp',live.tbmp,'#e3a23c'),'°',1);
  rng('rPresA','rPresB',drawChart('chPres',live.pres,'#5aa9e6'),'',0);
}
function pushLive(j){
  if(isNum(j.humidity)){live.hum.push(j.humidity);if(live.hum.length>LMAX)live.hum.shift()}
  if(isNum(j.tempSi)){live.tsi.push(j.tempSi);if(live.tsi.length>LMAX)live.tsi.shift()}
  if(isNum(j.airHum)){live.air.push(j.airHum);if(live.air.length>LMAX)live.air.shift()}
  if(isNum(j.tempBmp)){live.tbmp.push(j.tempBmp);if(live.tbmp.length>LMAX)live.tbmp.shift()}
  if(isNum(j.pressure)){live.pres.push(j.pressure);if(live.pres.length>LMAX)live.pres.shift()}
}
function seedLive(){
  fetch('/api/history',{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){
    var it=d.items||[];
    if(it.length){
      live.hum=it.map(function(x){return x.humidity}).filter(isNum).slice(-LMAX);
      live.tsi=it.map(function(x){return x.tempSi}).filter(isNum).slice(-LMAX);
      live.air=it.map(function(x){return x.airHum}).filter(isNum).slice(-LMAX);
      live.tbmp=it.map(function(x){return x.tempBmp}).filter(isNum).slice(-LMAX);
      live.pres=it.map(function(x){return x.pressure}).filter(isNum).slice(-LMAX);
      sparkData=live.hum.slice();drawSpark();
    }
    drawCharts();
  }).catch(function(){});
}
function tick(){
  fetch('/api/data',{cache:'no-store'}).then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(j){
    setOnline(true);
    if(j&&isNum(j.humidity)){
      var stale=j.ts&&(Date.now()-j.ts>10000), h=j.humidity, st=ESTADOS[j.state]||colorFor(h);
      currentRaw=isNum(j.raw)?j.raw:null;
      $('val').textContent=h;
      $('estado').textContent=stale?'SENSOR DESCONECTADO':st.txt;
      $('estado').style.color=stale?'#8b98a5':st.color;
      $('orb').style.background='radial-gradient(circle at 50% 38%,'+st.color+'2e,#0b1812)';
      $('orb').style.boxShadow=stale?'none':'0 0 34px 6px '+st.color+'55';
      $('subline').textContent=currentRaw!=null?('Humedad del musgo · ADC '+currentRaw):'Humedad del musgo';
      $('rawNow').textContent=currentRaw!=null?currentRaw:'—';
      $('humNow').textContent=h+' %';
      var dev=[];if(j.device)dev.push(j.device);if(isNum(j.rssi))dev.push('señal '+j.rssi+' dBm');
      $('devLabel').textContent=dev.join(' · ')||'—';
      setVal('aTemp',j.tempSi,' °C',1); setVal('aHum',j.airHum,' %',0);
      setVal('bTemp',j.tempBmp,' °C',1); setVal('bPres',j.pressure,' hPa',0);
      if(j.ts!==lastTs){lastTs=j.ts||Date.now();sparkData.push(h);if(sparkData.length>140)sparkData.shift();drawSpark();pushLive(j);drawCharts()}
    }else{$('estado').textContent='sin lecturas todavía'}
  }).catch(function(){setOnline(false)});
}
function refreshAgo(){if(lastTs)$('ago').textContent=relTime(lastTs)}
function loadConfig(){fetch('/api/config',{cache:'no-store'}).then(function(r){return r.json()}).then(function(c){if($('inSeco').value==='')$('inSeco').value=c.dryRaw;if($('inHumedo').value==='')$('inHumedo').value=c.wetRaw}).catch(function(){})}
function capturar(id){if(currentRaw==null){msg('Aún no hay lectura',true);return}$(id).value=currentRaw;msg('Capturado: '+currentRaw,false)}
function msg(t,err){var m=$('msg');m.textContent=t;m.style.color=err?'#f0594b':'#3fb950'}
function guardar(){var d=parseInt($('inSeco').value,10),w=parseInt($('inHumedo').value,10);if(isNaN(d)||isNaN(w)){msg('Escribe ambos valores',true);return}
  fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dryRaw:d,wetRaw:w})}).then(function(r){return r.json()}).then(function(j){msg(j.ok?'Calibración guardada ✓':((j.error||'Error')),!j.ok)}).catch(function(){msg('Error de red',true)})}
loadConfig();seedLive();tick();setInterval(tick,1000);setInterval(refreshAgo,1000);
</script>
</body>
</html>`;
