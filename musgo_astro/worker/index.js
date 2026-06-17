// Cloudflare Worker — API + dashboard del "Musgo que respira"
//
// Almacenamiento (KV "MUSGO_DATA"):
//   - "latest"  : ultima lectura del sensor (global, consistente entre datacenters).
//   - "config"  : calibracion { dryRaw, wetRaw } editable desde la web.
// Capa Cache API por-datacenter para lecturas casi en vivo sin gastar cuota de KV.
//
// Endpoints:
//   GET  /            -> dashboard (Monitor / Calibrar / Como funciona)
//   GET  /api/data    -> ultima lectura {humidity,state,raw,rssi,device,ts}
//   POST /api/data    -> guarda lectura; responde { ok, kv, config }
//   GET  /api/config  -> calibracion actual
//   POST /api/config  -> fija calibracion { dryRaw, wetRaw }
//   GET  /api/health  -> estado

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const HISTORY_MIN_GAP_MS = 3000;      // separacion minima entre puntos del historial
const MAX_HISTORY = 240;              // puntos guardados
const CACHE_BASE = 'https://musgo.internal/';
const DEFAULT_CONFIG = { dryRaw: 2515, wetRaw: 1128 }; // calibracion por defecto (musgo)

// Telemetria (latest + history) -> Cache API (sin limite de operaciones, gratis).
// Solo la calibracion usa KV (se escribe poquisimas veces) -> casi cero ops KV.
let memHistory = null;                // serie temporal en memoria del isolate
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
    temp: f1(body.temp),          // °C (BMP280, opcional)
    pressure: f1(body.pressure),  // hPa (BMP280, opcional)
    airHum: num(body.airHum),     // % humedad del aire (BME280, opcional)
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
    catch { /* usa default */ }
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
        if (Math.abs(dryRaw - wetRaw) < 200) return json({ ok: false, error: 'Seco y húmedo deben diferir bastante (≥200). Revisa la captura.' }, 422);
        const cfg = { dryRaw, wetRaw };
        await setConfig(env, cfg);
        return json({ ok: true, config: cfg });
      }
    }

    if (pathname === '/api/data' && request.method === 'POST') {
      let raw; try { raw = await request.json(); } catch { return json({ ok: false, error: 'JSON inválido' }, 400); }
      const reading = normalizeReading(raw);
      if (!reading) return json({ ok: false, error: 'Falta "humidity" numérico' }, 422);

      await cachePutKey('latest', reading); // telemetria en Cache API (sin KV)

      // Historial en memoria + Cache (separacion minima entre puntos).
      if (memHistory === null) { memHistory = (await cacheGetKey('history')) || []; }
      const last = memHistory[memHistory.length - 1];
      if (!last || reading.ts - (last.ts || 0) >= HISTORY_MIN_GAP_MS) {
        memHistory.push({ ts: reading.ts, humidity: reading.humidity, temp: reading.temp, pressure: reading.pressure, airHum: reading.airHum });
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
  .brand h1{font-size:16px;font-weight:650}
  .brand p{font-size:11.5px;color:var(--muted);margin-top:1px}
  .live{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--muted);border:1px solid var(--line);padding:6px 10px;border-radius:999px;background:var(--panel)}
  .dot{width:8px;height:8px;border-radius:50%;background:#5a6675;transition:.3s}
  nav{display:flex;gap:4px;background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:4px;margin-bottom:16px}
  nav button{flex:1;border:0;background:transparent;color:var(--muted);font:inherit;font-size:12px;font-weight:550;padding:8px 5px;border-radius:9px;cursor:pointer;transition:.15s}
  nav button.on{background:var(--panel);color:var(--fg)}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:22px}
  .gauge{display:flex;flex-direction:column;align-items:center;padding:8px 0 6px}
  .orb{width:160px;height:160px;border-radius:50%;display:flex;align-items:center;justify-content:center;
    background:radial-gradient(circle at 50% 38%,#16321f,#0b1812);position:relative;animation:breathe 5s ease-in-out infinite}
  @keyframes breathe{0%,100%{transform:scale(.95)}50%{transform:scale(1.05)}}
  .hum{font-size:52px;font-weight:750;line-height:1}
  .hum small{font-size:20px;color:var(--muted);font-weight:600}
  .estado{margin-top:12px;font-weight:700;letter-spacing:1px;font-size:15px;color:var(--muted)}
  .sub{margin-top:6px;font-size:11.5px;color:var(--muted)}
  .spark{display:flex;align-items:flex-end;gap:2px;height:50px;margin:18px 0 4px}
  .spark>div{flex:1;background:#26323f;border-radius:2px;min-height:2px;transition:height .4s}
  .meta{display:flex;justify-content:space-between;color:var(--muted);font-size:12px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
  .legend{display:flex;gap:8px;margin-top:14px}
  .chip{flex:1;text-align:center;font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:9px;padding:8px 4px}
  .chip b{display:block;font-size:12px;margin-bottom:2px}
  /* Calibrar */
  .readout{display:flex;gap:10px;margin-bottom:16px}
  .ro{flex:1;text-align:center;background:var(--panel2);border:1px solid var(--line);border-radius:11px;padding:12px 8px}
  .ro span{display:block;font-size:11px;color:var(--muted);margin-bottom:4px}
  .ro b{font-size:24px;font-weight:700}
  .calrow{margin:12px 0}
  .calrow label{display:block;font-size:12.5px;color:#c9d4de;margin-bottom:6px}
  .calrow label b{color:var(--fg)}
  .ctl{display:flex;gap:8px}
  .ctl input{flex:1;background:var(--panel2);border:1px solid var(--line);color:var(--fg);border-radius:9px;padding:10px;font:inherit;font-size:14px;min-width:0}
  .ctl button,.save{border:1px solid var(--line);background:var(--panel2);color:var(--fg);font:inherit;font-size:12.5px;font-weight:600;border-radius:9px;padding:0 12px;cursor:pointer;white-space:nowrap}
  .ctl button:active,.save:active{transform:translateY(1px)}
  .save{width:100%;padding:12px;margin-top:8px;background:var(--accent);color:#06210f;border-color:transparent;font-size:14px}
  .msg{font-size:12.5px;text-align:center;margin-top:10px;min-height:16px}
  .hint{font-size:12px;line-height:1.55;color:#c9d4de;background:var(--panel2);border:1px solid var(--line);border-radius:11px;padding:12px;margin-bottom:16px}
  .hint b{color:var(--fg)}
  /* Info */
  .info h2{font-size:14px;margin:18px 0 8px}
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
  .subnav{display:flex;gap:4px;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:3px;margin-bottom:16px}
  .subnav button{flex:1;border:0;background:transparent;color:var(--muted);font:inherit;font-size:12px;font-weight:550;padding:7px;border-radius:8px;cursor:pointer}
  .subnav button.on{background:var(--panel);color:var(--fg)}
  code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;background:var(--panel2);border:1px solid var(--line);border-radius:5px;padding:1px 5px;color:#c9d4de;white-space:nowrap}
  #hist.card{padding:14px 16px}
  .chartcard{background:var(--panel2);border:1px solid var(--line);border-radius:11px;padding:9px 12px;margin-bottom:8px}
  .charthead{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px;font-size:12px;color:#c9d4de}
  .charthead b{font-size:16px;color:var(--fg);font-weight:700}
  .chart{width:100%;height:34px;display:block;overflow:visible}
  .chartrange{display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-top:2px}
  .chartnote{font-size:10.5px;color:var(--muted);text-align:center;margin-top:6px}
  .schem{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;line-height:1.4;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:12px;color:#c9d4de;overflow-x:auto;white-space:pre;margin:4px 0}
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
    <button id="tabHist" onclick="ver('hist')">Historial</button>
    <button id="tabCal" onclick="ver('cal')">Calibrar</button>
    <button id="tabInfo" onclick="ver('info')">Cómo funciona</button>
  </nav>

  <!-- ===== Monitor ===== -->
  <section id="mon" class="card">
    <div class="gauge">
      <div id="orb" class="orb"><div class="hum"><span id="val">--</span><small>%</small></div></div>
      <div id="estado" class="estado">esperando datos…</div>
      <div id="subline" class="sub">&nbsp;</div>
    </div>
    <div class="spark" id="spark"></div>
    <div class="readout hidden" id="env" style="margin-top:16px">
      <div class="ro"><span>🌡️ Temperatura</span><b id="temp">—</b></div>
      <div class="ro"><span>⏱️ Presión</span><b id="pres">—</b></div>
      <div class="ro hidden" id="airBox"><span>💧 Hum. aire</span><b id="air">—</b></div>
    </div>
    <div class="meta"><span>Última lectura</span><span id="ago">—</span></div>
    <div class="legend">
      <div class="chip" style="border-color:#3a2420"><b style="color:var(--seco)">SECO</b>&lt; 30 %</div>
      <div class="chip" style="border-color:#3a3120"><b style="color:var(--medio)">MEDIO</b>30 – 60 %</div>
      <div class="chip" style="border-color:#20381f"><b style="color:var(--humedo)">HÚMEDO</b>&gt; 60 %</div>
    </div>
  </section>

  <!-- ===== Historial ===== -->
  <section id="hist" class="card hidden">
    <div class="chartcard">
      <div class="charthead"><span>💧 Humedad del musgo</span><b id="hHum">—</b></div>
      <svg class="chart" id="cHum" viewBox="0 0 300 56" preserveAspectRatio="none"></svg>
      <div class="chartrange"><span id="rHumA">—</span><span id="rHumB">—</span></div>
    </div>
    <div class="chartcard">
      <div class="charthead"><span>🌡️ Temperatura</span><b id="hTemp">—</b></div>
      <svg class="chart" id="cTemp" viewBox="0 0 300 56" preserveAspectRatio="none"></svg>
      <div class="chartrange"><span id="rTempA">—</span><span id="rTempB">—</span></div>
    </div>
    <div class="chartcard">
      <div class="charthead"><span>⏱️ Presión</span><b id="hPres">—</b></div>
      <svg class="chart" id="cPres" viewBox="0 0 300 56" preserveAspectRatio="none"></svg>
      <div class="chartrange"><span id="rPresA">—</span><span id="rPresB">—</span></div>
    </div>
    <div class="chartcard hidden" id="airCard">
      <div class="charthead"><span>💨 Humedad del aire</span><b id="hAir">—</b></div>
      <svg class="chart" id="cAir" viewBox="0 0 300 56" preserveAspectRatio="none"></svg>
      <div class="chartrange"><span id="rAirA">—</span><span id="rAirB">—</span></div>
    </div>
    <div class="chartnote">💧 musgo (suelo) · 🌡️ ⏱️ ambiente · 💨 aire (Si7021/BME280)</div>
    <div class="meta"><span>Muestras en la nube</span><span id="histCount">—</span></div>
  </section>

  <!-- ===== Calibrar ===== -->
  <section id="cal" class="card hidden">
    <div class="hint">
      <b>Calibra el sensor con tu musgo (2 puntos):</b><br>
      1) Con el musgo <b>seco</b>, pulsa <b>“Capturar”</b> en SECO.<br>
      2) Riega bien el musgo, espera que absorba, y pulsa <b>“Capturar”</b> en HÚMEDO.<br>
      3) Pulsa <b>Guardar</b>. El ESP32 se recalibra solo en segundos.
    </div>
    <div class="readout">
      <div class="ro"><span>Lectura cruda (ADC)</span><b id="rawNow">—</b></div>
      <div class="ro"><span>Humedad actual</span><b id="humNow">—</b></div>
    </div>
    <div class="calrow">
      <label>Punto <b>SECO</b> &nbsp;·&nbsp; ADC con musgo seco</label>
      <div class="ctl">
        <input id="inSeco" type="number" min="0" max="4095" inputmode="numeric" />
        <button onclick="capturar('inSeco')">Capturar</button>
      </div>
    </div>
    <div class="calrow">
      <label>Punto <b>HÚMEDO</b> &nbsp;·&nbsp; ADC con musgo mojado</label>
      <div class="ctl">
        <input id="inHumedo" type="number" min="0" max="4095" inputmode="numeric" />
        <button onclick="capturar('inHumedo')">Capturar</button>
      </div>
    </div>
    <button class="save" onclick="guardar()">Guardar calibración</button>
    <div id="msg" class="msg"></div>
  </section>

  <!-- ===== Cómo funciona ===== -->
  <section id="info" class="card info hidden">
    <div class="subnav">
      <button id="subBas" class="on" onclick="nivel('bas')">Explicación básica</button>
      <button id="subTec" onclick="nivel('tec')">Explicación técnica</button>
    </div>

    <div id="infoBasica">
    <h2>🌱 ¿Qué es?</h2>
    <p><b>Musgo que respira</b> le da “voz” a una planta de musgo. Un sensor mide cuánta agua tiene el musgo y, según eso, la obra <b>cambia de color, emite sonidos</b> y muestra su estado <b>en vivo por internet</b> en este panel. Sensores ambientales (<b>BMP280</b> + <b>Si7021</b>) miden la <b>temperatura</b>, la <b>presión</b> y la <b>humedad del aire</b>. Cada caja de Petri con musgo tiene su indicador <b>LED</b>.</p>

    <h2>⚙️ ¿Cómo funciona?</h2>
    <ol class="flow">
      <li>Un <b>sensor de humedad</b> mide el agua en el musgo varias veces por segundo.</li>
      <li>Una placa <b>ESP32</b> lo convierte en un porcentaje (0–100 %) usando la <b>calibración</b> y decide el estado.</li>
      <li>El ESP32 lo envía por <b>WiFi</b> a un servidor en la nube (<b>Cloudflare</b>) cada 2 segundos.</li>
      <li>El servidor guarda la lectura y devuelve la calibración (así el sensor se ajusta desde la web).</li>
      <li>Este <b>panel</b> la muestra y se actualiza solo, sin recargar.</li>
    </ol>

    <h2>🎨🔊 Estados, color y sonido</h2>
    <table>
      <tr><th>Estado</th><th>LED</th><th>Sonido</th></tr>
      <tr><td><span class="tag" style="background:var(--humedo)"></span><b>Húmedo</b><br>&gt; 60 %</td><td>Verde</td><td>Casi en silencio. Un <b>“check”</b> suave que confirma que está bien.</td></tr>
      <tr><td><span class="tag" style="background:var(--medio)"></span><b>Medio</b><br>30–60 %</td><td>Ámbar</td><td><b>Alerta media</b>: doble tono cada ~12 s.</td></tr>
      <tr><td><span class="tag" style="background:var(--seco)"></span><b>Seco</b><br>&lt; 30 %</td><td>Rojo</td><td><b>Súper alerta</b>: ráfaga aguda insistente cada ~4 s. ¡Necesita agua!</td></tr>
    </table>
    <p style="margin-top:10px">Al <b>cambiar de estado</b> suena un “ding-dong” identificador y luego la alerta del nuevo estado.</p>

    <h2>🔧 Calibración</h2>
    <p>Cada sensor y cada musgo son distintos. En la pestaña <b>Calibrar</b> fijas el valor con el musgo seco y con el musgo mojado; el sistema traduce todo a 0–100 % automáticamente.</p>

    <h2>🧩 Tecnología</h2>
    <div class="tech">
      <span>ESP32</span><span>Sensor de humedad</span><span>BMP280</span><span>Si7021</span><span>LED RGB ×2</span><span>LED bicolor</span><span>Buzzer</span>
      <span>Cloudflare Workers</span><span>Cache API</span><span>KV (config)</span><span>HTTPS</span>
    </div>
    </div><!-- /infoBasica -->

    <div id="infoTecnica" class="hidden">
      <h2>🏗️ ¿Dónde vive todo?</h2>
      <p>Todo se aloja en <b>un único Cloudflare Worker</b>: cómputo <b>serverless</b> que corre en el <b>borde (edge)</b> de la red de Cloudflare, repartido por datacenters de todo el mundo. Ese mismo Worker, con <b>una sola URL</b>, sirve esta página (ruta <code>/</code>) y la API (rutas <code>/api/*</code>). <b>No hay un servidor encendido ni una base de datos que mantener</b>: el código solo se ejecuta cuando llega una petición.</p>

      <h2>🔁 Flujo de datos (técnico)</h2>
      <ol class="flow">
        <li><b>Firmware ESP32</b> (Arduino / C++): promedia 16 muestras del ADC del sensor de humedad, aplica filtro <b>EMA</b>, lee los sensores <b>I²C</b> (BMP280: presión; Si7021: temperatura y humedad del aire) y hace <b>HTTPS POST</b> a <code>/api/data</code> cada 2 s con un JSON <code>{humidity, state, raw, temp, pressure, airHum, ts}</code>. El TLS lo maneja <code>WiFiClientSecure</code>.</li>
        <li>El Worker <b>valida y normaliza</b> la lectura, le pone marca de tiempo del servidor y la guarda en dos capas (ver abajo).</li>
        <li>En la <b>respuesta del POST</b>, el Worker devuelve la calibración <code>{dryRaw, wetRaw}</code>; el ESP32 la aplica y <b>se recalibra en caliente</b> sin reprogramarse.</li>
        <li>Esta página pide <code>GET /api/data</code> cada 1.5 s por <b>fetch (AJAX)</b> y se redibuja sin recargar.</li>
      </ol>

      <h2>🗄️ Almacenamiento</h2>
      <table>
        <tr><th>Capa</th><th>Para qué sirve</th></tr>
        <tr><td><b>Workers KV</b><br><code>latest</code> · <code>config</code></td><td>Almacén <b>global y consistente</b> entre datacenters. Escritura limitada (cada 15 s) para respetar la cuota gratuita.</td></tr>
        <tr><td><b>Cache API</b><br>por datacenter</td><td>Lecturas de <b>baja latencia</b> sin gastar cuota. La página lee de aquí si el dato es fresco (&lt; 20 s) y, si no, recurre a KV.</td></tr>
      </table>

      <h2>🔌 Endpoints (la API)</h2>
      <table>
        <tr><th>Ruta</th><th>Función</th></tr>
        <tr><td><code>GET /</code></td><td>Este dashboard (HTML)</td></tr>
        <tr><td><code>GET /api/data</code></td><td>Última lectura</td></tr>
        <tr><td><code>POST /api/data</code></td><td>Recibe la lectura → responde la calibración</td></tr>
        <tr><td><code>GET·POST /api/config</code></td><td>Leer / fijar la calibración</td></tr>
        <tr><td><code>GET /api/health</code></td><td>Estado del servicio</td></tr>
      </table>

      <h2>🚀 Hosting y despliegue</h2>
      <ol class="flow">
        <li>El código vive en <b>GitHub</b> (<code>lakerstrake/musgo_esp32</code>).</li>
        <li>Un solo comando <code>npx wrangler deploy</code> sube el Worker al <b>edge global</b> de Cloudflare.</li>
        <li><b>HTTPS automático</b> en <code>*.workers.dev</code>; escala solo, sin contenedores ni máquinas virtuales.</li>
      </ol>

      <h2>🔌 Esquemático de conexiones</h2>
<pre class="schem">                 ESP32 DevKit
              ┌───────────────┐
  Musgo AOUT ─┤ D34           │
  RGB1 R/G/B ─┤ D25/D26/D14   │  musgo
  RGB1 común ─┤ D27 (+)       │
  RGB2 R/G/B ─┤ D2/D4/D16     │  aire
  Bicolor R/Y─┤ D5/D18        │  alerta
  Buzzer + ───┤ D22           │
  I2C SDA/SCL─┤ D19/D21       │  BMP280/BME280
              │               │  + Si7021
              └───────────────┘</pre>
      <table>
        <tr><th>Componente</th><th>Conexión a la ESP32</th></tr>
        <tr><td><b>Sensor musgo</b></td><td>AOUT→<code>D34</code> · VCC/GND</td></tr>
        <tr><td><b>RGB 1</b> (musgo)</td><td>R/G/B→<code>D25/D26/D14</code> · común(+)→<code>D27</code></td></tr>
        <tr><td><b>RGB 2</b> (aire)</td><td>R/G/B→<code>D2/D4/D16</code> · común→GND</td></tr>
        <tr><td><b>Bicolor</b> (alerta)</td><td>rojo→<code>D5</code> · amarillo→<code>D18</code> · común→GND</td></tr>
        <tr><td><b>Buzzer</b></td><td>+→<code>D22</code> · −→GND</td></tr>
        <tr><td><b>BMP280 + Si7021</b></td><td>SDA→<code>D19</code> · SCL→<code>D21</code> (I²C)</td></tr>
      </table>
      <p style="margin-top:8px">Esquemático completo y notas en <code>CONEXIONES.md</code>. RGB 1 es ánodo común; RGB 2 y bicolor, cátodo común.</p>
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
var lastTs=0, hist=[], currentRaw=null;
function colorFor(h){return h<30?ESTADOS[0]:h<60?ESTADOS[1]:ESTADOS[2]}
function relTime(ms){var s=Math.round((Date.now()-ms)/1000);if(s<2)return'ahora';if(s<60)return'hace '+s+'s';return'hace '+Math.round(s/60)+' min'}
function setOnline(ok){$('status').textContent=ok?'en línea':'sin conexión';$('dot').style.background=ok?'#3fb950':'#f0594b'}
function ver(t){
  ['mon','hist','cal','info'].forEach(function(s){$(s).classList.toggle('hidden',s!==t)});
  $('tabMon').classList.toggle('on',t==='mon');$('tabHist').classList.toggle('on',t==='hist');
  $('tabCal').classList.toggle('on',t==='cal');$('tabInfo').classList.toggle('on',t==='info');
  if(t==='cal')loadConfig();
  if(t==='hist')seedLive();
  if(t==='info')nivel('bas');
}
function drawChart(svgId,vals,color){
  var el=$(svgId); if(!el)return null;
  var pts=[]; for(var i=0;i<vals.length;i++){ if(typeof vals[i]==='number')pts.push(vals[i]); }
  if(pts.length<2){ el.innerHTML=''; return null; }
  var min=Math.min.apply(null,pts),max=Math.max.apply(null,pts),range=(max-min)||1;
  var W=300,H=56,n=pts.length,d='';
  for(var k=0;k<n;k++){ var x=(k/(n-1))*W; var y=H-4-((pts[k]-min)/range)*(H-8); d+=(k?'L':'M')+x.toFixed(1)+' '+y.toFixed(1)+' '; }
  var area=d+'L300 56 L0 56 Z';
  el.innerHTML='<path d="'+area+'" fill="'+color+'22"/><path d="'+d+'" fill="none" stroke="'+color+'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
  return {min:min,max:max,last:pts[pts.length-1]};
}
// Buffer en vivo en el navegador: las graficas se actualizan en cada lectura.
var live={hum:[],temp:[],pres:[],air:[]}, LIVE_MAX=120;
function isNum(v){return typeof v==='number'}
function pushLive(j){
  if(isNum(j.humidity)){live.hum.push(j.humidity);if(live.hum.length>LIVE_MAX)live.hum.shift()}
  if(isNum(j.temp)){live.temp.push(j.temp);if(live.temp.length>LIVE_MAX)live.temp.shift()}
  if(isNum(j.pressure)){live.pres.push(j.pressure);if(live.pres.length>LIVE_MAX)live.pres.shift()}
  if(isNum(j.airHum)){live.air.push(j.airHum);if(live.air.length>LIVE_MAX)live.air.shift()}
}
function drawCharts(){
  $('histCount').textContent=Math.max(live.hum.length,live.temp.length,live.pres.length);
  var rh=drawChart('cHum',live.hum,'#3fb950');
  var rt=drawChart('cTemp',live.temp,'#e3a23c');
  var rp=drawChart('cPres',live.pres,'#5aa9e6');
  var ra=drawChart('cAir',live.air,'#5fd0d6');
  if(rh){$('hHum').textContent=rh.last+' %';$('rHumA').textContent='mín '+rh.min+'%';$('rHumB').textContent='máx '+rh.max+'%'}
  else{$('hHum').textContent='—';$('rHumA').textContent='—';$('rHumB').textContent=''}
  if(rt){$('hTemp').textContent=rt.last.toFixed(1)+' °C';$('rTempA').textContent='mín '+rt.min.toFixed(1)+'°';$('rTempB').textContent='máx '+rt.max.toFixed(1)+'°'}
  else{$('hTemp').textContent='sin BMP280';$('rTempA').textContent='conecta el sensor';$('rTempB').textContent=''}
  if(rp){$('hPres').textContent=Math.round(rp.last)+' hPa';$('rPresA').textContent='mín '+Math.round(rp.min);$('rPresB').textContent='máx '+Math.round(rp.max)}
  else{$('hPres').textContent='sin BMP280';$('rPresA').textContent='conecta el sensor';$('rPresB').textContent=''}
  if(ra){$('airCard').classList.remove('hidden');$('hAir').textContent=ra.last+' %';$('rAirA').textContent='mín '+ra.min+'%';$('rAirB').textContent='máx '+ra.max+'%'}
  else{$('airCard').classList.add('hidden')}
}
function seedLive(){
  fetch('/api/history',{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){
    var it=d.items||[];
    if(it.length>live.hum.length){
      live.hum=it.map(function(x){return x.humidity}).filter(isNum).slice(-LIVE_MAX);
      live.temp=it.map(function(x){return x.temp}).filter(isNum).slice(-LIVE_MAX);
      live.pres=it.map(function(x){return x.pressure}).filter(isNum).slice(-LIVE_MAX);
      live.air=it.map(function(x){return x.airHum}).filter(isNum).slice(-LIVE_MAX);
    }
    drawCharts();
  }).catch(function(){drawCharts()});
}
function nivel(t){
  $('infoBasica').classList.toggle('hidden',t!=='bas');
  $('infoTecnica').classList.toggle('hidden',t!=='tec');
  $('subBas').classList.toggle('on',t==='bas');
  $('subTec').classList.toggle('on',t==='tec');
}
function drawSpark(){var s=$('spark');s.innerHTML='';hist.slice(-44).forEach(function(h){var b=document.createElement('div');b.style.height=Math.max(2,h)+'%';b.style.background=colorFor(h).color;s.appendChild(b)})}
function tick(){
  fetch('/api/data',{cache:'no-store'}).then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(j){
    setOnline(true);
    if(j&&typeof j.humidity==='number'){
      var stale=j.ts&&(Date.now()-j.ts>10000);
      var h=j.humidity, st=ESTADOS[j.state]||colorFor(h);
      currentRaw=(typeof j.raw==='number')?j.raw:null;
      $('val').textContent=h;
      $('estado').textContent=stale?'SENSOR DESCONECTADO':st.txt;
      $('estado').style.color=stale?'#8b98a5':st.color;
      $('orb').style.background='radial-gradient(circle at 50% 38%,'+st.color+'2e,#0b1812)';
      $('orb').style.boxShadow=stale?'none':'0 0 34px 6px '+st.color+'55';
      var bits=[];
      if(currentRaw!=null)bits.push('ADC '+currentRaw);
      if(typeof j.rssi==='number')bits.push('señal '+j.rssi+' dBm');
      if(j.device)bits.push(j.device);
      $('subline').textContent=bits.join('  ·  ')||'\\u00a0';
      $('rawNow').textContent=currentRaw!=null?currentRaw:'—';
      $('humNow').textContent=h+' %';
      var hasEnv=(typeof j.temp==='number')||(typeof j.pressure==='number');
      $('env').classList.toggle('hidden',!hasEnv);
      if(typeof j.temp==='number')$('temp').textContent=j.temp.toFixed(1)+' °C';
      if(typeof j.pressure==='number')$('pres').textContent=Math.round(j.pressure)+' hPa';
      if(typeof j.airHum==='number'){$('airBox').classList.remove('hidden');$('air').textContent=j.airHum+' %'}
      if(j.ts!==lastTs){lastTs=j.ts||Date.now();hist.push(h);if(hist.length>140)hist.shift();drawSpark();pushLive(j);if(!$('hist').classList.contains('hidden'))drawCharts()}
    }else{$('estado').textContent='sin lecturas todavía'}
  }).catch(function(){setOnline(false)});
}
function refreshAgo(){if(lastTs)$('ago').textContent=relTime(lastTs)}
function loadConfig(){
  fetch('/api/config',{cache:'no-store'}).then(function(r){return r.json()}).then(function(c){
    if($('inSeco').value==='')$('inSeco').value=c.dryRaw;
    if($('inHumedo').value==='')$('inHumedo').value=c.wetRaw;
  }).catch(function(){});
}
function capturar(id){ if(currentRaw==null){msg('Aún no hay lectura del sensor',true);return} $(id).value=currentRaw; msg('Capturado: '+currentRaw,false); }
function msg(t,err){var m=$('msg');m.textContent=t;m.style.color=err?'#f0594b':'#3fb950'}
function guardar(){
  var d=parseInt($('inSeco').value,10), w=parseInt($('inHumedo').value,10);
  if(isNaN(d)||isNaN(w)){msg('Escribe ambos valores',true);return}
  fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dryRaw:d,wetRaw:w})})
    .then(function(r){return r.json()}).then(function(j){ msg(j.ok?'Calibración guardada ✓ (el sensor se ajusta solo)':((j.error||'Error')),!j.ok); })
    .catch(function(){msg('Error de red',true)});
}
seedLive();tick();setInterval(tick,1000);setInterval(refreshAgo,1000);
</script>
</body>
</html>`;
