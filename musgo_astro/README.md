# Musgo que respira 🌿

Monitor en línea de un sensor de humedad conectado a un ESP32.

```
ESP32  ──POST /api/data──▶  Cloudflare Worker  ◀──GET /api/data──  Web (Astro)
 (sensor + LED + buzzer)        (guarda lectura)                    (dashboard)
```

- `esp32/musgo_esp32_http.ino` — sketch que lee el sensor y hace POST de la humedad.
- `worker/` — Cloudflare Worker: API REST que guarda la última lectura + histórico.
- `web/` — dashboard Astro que muestra los datos en vivo.

---

## 1) Desplegar el Worker (la API)

El Worker **funciona sin configurar nada de almacenamiento** (usa Cache API + memoria).
Ya está configurado el `account_id` y el nombre `musgoesp32` en `wrangler.toml`.

```powershell
cd musgo_astro
npx wrangler login        # solo la primera vez
npx wrangler deploy
```

Anota la URL que imprime, por ejemplo: `https://musgoesp32.<tu-subdominio>.workers.dev`

**Endpoints:**
- `POST /api/data` — recibe `{ "humidity": 0-100, "state": 0|1|2, "device": "...", "ts": millis }`
- `GET  /api/data` — última lectura
- `GET  /api/history` — últimas 120 lecturas
- `GET  /api/health` — estado del servicio

### (Opcional) Almacenamiento durable con KV
Sin KV, los datos se pierden si el Worker se reinicia. Para hacerlos persistentes:

```powershell
npx wrangler kv namespace create MUSGO_DATA
```

Copia el `id`, descomenta el bloque `[[kv_namespaces]]` en `wrangler.toml`, pega el id y vuelve a desplegar.

---

## 2) Configurar el ESP32

En `esp32/musgo_esp32_http.ino`:
- `serverUrl` → la URL de tu Worker + `/api/data`
  (ej: `https://musgoesp32.<tu-subdominio>.workers.dev/api/data`)
- `ssid` → tu red WiFi (la red `UNAL` es abierta, sin contraseña).

Sube el sketch con Arduino IDE o PlatformIO. Ya incluye TLS (`WiFiClientSecure`) y reconexión WiFi automática.

---

## 3) Desplegar la web (Astro) en Cloudflare Pages

1. En Cloudflare Pages, crea un proyecto conectado a este repo.
2. **Build command:** `npm run build` · **Build output:** `web/dist` · **Root directory:** `musgo_astro`
3. Añade la variable de entorno **`PUBLIC_API_URL`** con la URL base del Worker
   (ej: `https://musgoesp32.<tu-subdominio>.workers.dev` — sin `/api/data`).

> ⚠️ No uses `npx wrangler deploy` como comando de build de **Pages**: eso es solo para el Worker.

### Despliegue automático con GitHub Actions
El repo incluye workflows en `.github/workflows/`. Añade estos secrets en GitHub:
- Worker: `CF_API_TOKEN`
- Pages: `CF_PAGES_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_PAGES_PROJECT_NAME`

---

## Flujo de datos
1. El ESP32 hace POST de la humedad cada ~2 s.
2. El Worker guarda la última lectura y la añade al histórico.
3. La web hace GET cada 1.5 s y dibuja humedad, estado y la mini-gráfica histórica.
