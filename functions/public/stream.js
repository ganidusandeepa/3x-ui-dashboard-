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
  const PANEL_API_TOKEN = env.PANEL_API_TOKEN || null;

  // Build auth headers: Bearer token when configured, otherwise session cookie.
  function panelHeaders(cookie, extra) {
    return Object.assign({}, extra || {},
      PANEL_API_TOKEN ? { Authorization: `Bearer ${PANEL_API_TOKEN}` } : { Cookie: cookie });
  }

  async function getSession() {
    if (PANEL_API_TOKEN) return 'token';
    // 3x-ui 3.6.0+ JSON login, then legacy form-encoded fallback.
    try {
      const r = await fetch(`${PANEL_URL}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }), redirect: 'follow'
      });
      const c = r.headers.get('set-cookie');
      if (c) return c;
    } catch (e) {}
    const loginRes = await fetch(`${PANEL_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS }),
      redirect: 'follow'
    });
    return loginRes.headers.get('set-cookie');
  }

  // Cache the online-clients list briefly so we don't hammer the panel each tick.
  const onlinesCacheKey = new Request('https://cache.local/xui/clients/onlines');
  async function fetchOnlinesCached(cookie) {
    try {
      const cache = caches.default;
      const hit = await cache.match(onlinesCacheKey);
      if (hit) return await hit.json();
      let list = [];
      for (const p of ['clients/onlines', 'inbounds/onlines']) {
        try {
          const r = await fetch(`${PANEL_URL}/panel/api/${p}`, {
            method: 'POST', headers: panelHeaders(cookie, { 'Content-Type': 'application/json' }), body: JSON.stringify({})
          });
          const j = await r.json();
          if (j && j.success && Array.isArray(j.obj)) { list = j.obj; break; }
        } catch (e) {}
      }
      const resp = new Response(JSON.stringify(list), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `s-maxage=${cacheTtlSeconds}` }
      });
      await cache.put(onlinesCacheKey, resp.clone());
      return await resp.json();
    } catch (e) { return []; }
  }

  const cacheTtlSeconds = Number(env.METRICS_CACHE_TTL || 3);
  const cacheKey = new Request('https://cache.local/xui/inbounds/list');

  async function fetchInboundsCached(cookie) {
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return await hit.json();

    const apiRes = await fetch(`${PANEL_URL}/panel/api/inbounds/list`, {
      method: 'GET',
      headers: panelHeaders(cookie, { Accept: 'application/json', Referer: `${PANEL_URL}/` })
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
          // Authoritative online status each tick so the UI pill doesn't
          // flip back to "AWAY" between full reloads.
          let isOnline = false;
          try {
            const onlines = await fetchOnlinesCached(cookie);
            if (Array.isArray(onlines)) isOnline = onlines.includes(client.email);
          } catch (e) {}

          // Only send what the UI needs frequently.
          await send('client', {
            ts: Date.now(),
            email: client.email,
            down: client.down,
            up: client.up,
            total: client.total,
            enable: client.enable,
            isOnline,
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
