Resumen rápido

Este repositorio contiene:
- `esp32/musgo_esp32_http.ino` : sketch que envía datos por HTTP POST a un endpoint.
- `web/` : proyecto Astro minimal para mostrar datos en línea (cliente polling cada 1s).
- `worker/` : Cloudflare Worker que guarda la última lectura en KV y expone `/api/data`.

Pasos resumidos para visualizar online

1) Crear un namespace KV en Cloudflare:
   - Instala `wrangler` (CLI de Cloudflare):

```powershell
npm install -g wrangler
```

   - Autentica: `wrangler login`
   - Crear namespace:

```powershell
wrangler kv:namespace create "MUSGO_DATA"
```

   - Copia el `id` que imprime y pégalo en `worker/wrangler.toml` en `YOUR_KV_NAMESPACE_ID`. Pone también `account_id`.

2) Publicar el Worker:

```powershell
cd worker
wrangler publish
```

Anota la URL del worker (ej: https://musgo-worker.yourdomain.workers.dev)

3) Actualizar el sketch ESP32:
   - Edita `esp32/musgo_esp32_http.ino` y cambia `serverUrl` por `https://.../api/data` (la URL del worker)
   - Subir el sketch al ESP32 (Arduino IDE / PlatformIO). La red `UNAL` es abierta, no requiere contraseña.

4) Desplegar la web Astro en Cloudflare Pages (opcional):
   - Inicializa el repo en GitHub y sube `web/` y `worker/`.
   - En Cloudflare Pages, crea un nuevo proyecto, conecta tu repo y usa `npm run build` como comando de build y `dist` como carpeta de publicación.
   - Define una variable de entorno `PUBLIC_API_URL` con la URL del Worker (ej: `https://musgo-worker.../api/data`).

5) Flujo de datos:
   - El ESP32 hace POST de JSON a `/api/data` cada ~2s.
   - El Worker guarda la lectura en KV.
   - La web (Astro) hace GET a `/api/data` cada 1s para mostrar la última lectura.

Notas y alternativas

- Si no quieres usar Cloudflare KV, puedes exponer el ESP32 a Internet con ngrok/Cloudflare Tunnel y poner la URL directa en la web. Eso evita usar Workers.
- Para baja latencia real-time usar SSE o WebSocket; aquí usamos polling por simplicidad y compatibilidad con Pages.

Si quieres, despliego el sitio Astro al repositorio y creo el `GitHub Actions` para publicar en Pages. ¿Lo hacemos?