addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

// Cambia "MUSGO_DATA" por el binding KV que configures en wrangler.toml
const KV = MUSGO_DATA; // binding

async function handleRequest(request){
  const url = new URL(request.url);
  if (url.pathname === '/api/data' && request.method === 'GET'){
    const v = await KV.get('latest');
    if (!v) return new Response(JSON.stringify({}), {headers: {'Content-Type':'application/json'}});
    return new Response(v, {headers: {'Content-Type':'application/json'}});
  }
  if (url.pathname === '/api/data' && request.method === 'POST'){
    try{
      const body = await request.text();
      // opcional: validar JSON
      await KV.put('latest', body);
      return new Response(JSON.stringify({ok:true}), {headers:{'Content-Type':'application/json'}});
    }catch(e){
      return new Response(JSON.stringify({ok:false,error:e.message}), {status:500, headers:{'Content-Type':'application/json'}});
    }
  }
  return new Response('Not found', {status:404});
}