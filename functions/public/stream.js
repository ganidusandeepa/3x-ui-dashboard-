// SSE stream for client traffic + speed updates.
// Public endpoint (same exposure model as /public/auth). Client identifies by ?id=<emailOrId>

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });

  const url = new URL(request.url);
  const id = (url.searchParams.get('id') || '').trim();
  if (!id) {
    return new Response(JSON.stringify({ success: false, msg: 'Missing id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const PANEL_URL_RAW = env.PANEL_URL || 'http://127.0.0.1:2053';
  const PANEL_URL = PANEL_URL_RAW.replace(/\/$/, '');
  const ADMIN_USER = env.PANEL_USERNAME || 'admin';
  const ADMIN_PASS = env.PANEL_PASSWORD || 'password';

  async function getSession() {
    const loginRes = await fetch(`${PANEL_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS }),
      redirect: 'follow'
    });
    return loginRes.headers.get('set-cookie');
  }

  const cacheTtlSeconds = Number(env.METRICS_CACHE_TTL || 3);
  const cacheKey = new Request('https://cache.local/xui/inbounds/list');

  async function fetchInboundsCached(cookie) {
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return await hit.json();

    const apiRes = await fetch(`${PANEL_URL}/panel/api/inbounds/list`, {
      method: 'GET',
      headers: {
        Cookie: cookie,
        Accept: 'application/json',
        Referer: `${PANEL_URL}/`
      }
    });
    const data = await apiRes.json();

    const resp = new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `s-maxage=${cacheTtlSeconds}`
      }
    });
    await cache.put(cacheKey, resp.clone());
    return await resp.json();
  }

  const intervalMs = Math.max(1000, Number(env.METRICS_INTERVAL_MS || 3000));

  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await writer.close(); } catch (_) {}
  };

  request.signal.addEventListener('abort', () => { close(); });

  const send = async (event, dataObj) => {
    if (closed) return;
    const payload = typeof dataObj === 'string' ? dataObj : JSON.stringify(dataObj);
    await writer.write(encoder.encode(`event: ${event}\ndata: ${payload}\n\n`));
  };

  const findClient = (inboundsData) => {
    if (!inboundsData || !inboundsData.success || !Array.isArray(inboundsData.obj)) return null;
    let foundClient = null;
    inboundsData.obj.forEach((inb) => {
      const stats = inb?.clientStats;
      if (!Array.isArray(stats)) return;
      const c = stats.find((x) => String(x.email) === id);
      if (c) foundClient = { ...c, inboundId: inb.id };
    });
    return foundClient;
  };

  (async () => {
    try {
      await send('hello', { ok: true, intervalMs, cacheTtlSeconds, ts: Date.now() });

      while (!closed) {
        const cookie = await getSession();
        if (!cookie) {
          await send('error', { msg: 'Panel Auth Failed' });
          await new Promise((r) => setTimeout(r, intervalMs));
          continue;
        }

        const inbounds = await fetchInboundsCached(cookie);
        const client = findClient(inbounds);

        if (!client) {
          await send('notfound', { id, ts: Date.now() });
        } else {
          // Only send what UI needs frequently.
          await send('client', {
            ts: Date.now(),
            email: client.email,
            down: client.down,
            up: client.up,
            total: client.total,
            enable: client.enable,
            lastOnline: client.lastOnline,
            uuid: client.uuid,
            subId: client.subId
          });
        }

        await writer.write(encoder.encode(`: ping ${Date.now()}\n\n`));
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    } catch (e) {
      try { await send('error', { msg: String(e?.message || e) }); } catch (_) {}
      await close();
    }
  })();

  return new Response(stream.readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  });
}
