// SSE stream for lightweight, near-realtime metrics updates.
// Auth: same as other /api/* routes (Cloudflare Access or Bearer token).

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const PANEL_URL_RAW = env.PANEL_URL || 'http://127.0.0.1:2053';
  const PANEL_URL = PANEL_URL_RAW.replace(/\/$/, '');
  const ADMIN_USER = env.PANEL_USERNAME || 'admin';
  const ADMIN_PASS = env.PANEL_PASSWORD || 'password';

  // ---- Auth (mirrors functions/api/[[path]].js logic) ----
  const authHeader = request.headers.get('Authorization');
  const cfUserRecord = request.headers.get('Cf-Access-Authenticated-User-Email');
  const hasEmailHeader = !!cfUserRecord;
  const hasJwtAssertion = !!request.headers.get('Cf-Access-Jwt-Assertion');
  const cookieHdr = request.headers.get('Cookie') || '';
  const hasCfAuthCookie = /(?:^|;\s*)CF_Authorization=/.test(cookieHdr);
  const isZeroTrustAdmin = hasEmailHeader || hasJwtAssertion || hasCfAuthCookie;

  if (authHeader !== `Bearer ${ADMIN_PASS}` && !isZeroTrustAdmin) {
    return new Response(JSON.stringify({ success: false, msg: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  async function getSession() {
    const loginRes = await fetch(`${PANEL_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS }),
      redirect: 'follow'
    });
    return loginRes.headers.get('set-cookie');
  }

  // Cache panel status for a few seconds to prevent hammering your origin.
  const cacheKey = new Request('https://cache.local/xui/status');
  const cacheTtlSeconds = Number(env.METRICS_CACHE_TTL || 3);

  async function fetchStatusCached() {
    try {
      const cache = caches.default;
      const hit = await cache.match(cacheKey);
      if (hit) {
        return await hit.json();
      }

      const cookie = await getSession();
      if (!cookie) throw new Error('Panel Auth Failed');

      const apiRes = await fetch(`${PANEL_URL}/panel/api/server/status`, {
        method: 'GET',
        headers: {
          Cookie: cookie,
          Accept: 'application/json',
          Referer: `${PANEL_URL}/`
        }
      });

      const data = await apiRes.json();

      const resp = new Response(JSON.stringify({ success: true, obj: data.obj || data }), {
        headers: {
          'Content-Type': 'application/json',
          // Edge cache hint (not for browser):
          'Cache-Control': `s-maxage=${cacheTtlSeconds}`
        }
      });
      // Put into edge cache.
      await cache.put(cacheKey, resp.clone());
      return await resp.json();
    } catch (e) {
      return { success: false, msg: String(e?.message || e) };
    }
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

  // If client disconnects, stop work.
  const abort = request.signal;
  abort.addEventListener('abort', () => { close(); });

  // Send helper
  const send = async (event, dataObj) => {
    if (closed) return;
    const payload = typeof dataObj === 'string' ? dataObj : JSON.stringify(dataObj);
    const msg = `event: ${event}\ndata: ${payload}\n\n`;
    await writer.write(encoder.encode(msg));
  };

  // Kick off async loop (do not await)
  (async () => {
    try {
      // hello
      await send('hello', { ok: true, intervalMs, cacheTtlSeconds, ts: Date.now() });

      while (!closed) {
        const status = await fetchStatusCached();
        await send('metrics', { ts: Date.now(), status });

        // heartbeat comment to keep some proxies happy
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
      // Disable buffering on some proxies
      'X-Accel-Buffering': 'no'
    }
  });
}
