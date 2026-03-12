export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const PANEL_URL_RAW = env.PANEL_URL || "http://127.0.0.1:2053";
  const PANEL_URL = PANEL_URL_RAW.replace(/\/$/, "");
  const ADMIN_USER = env.PANEL_USERNAME || "admin";
  const ADMIN_PASS = env.PANEL_PASSWORD || "password";

  const path = url.pathname.replace('/api/', '');

  async function getSession() {
    const loginRes = await fetch(`${PANEL_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS }),
      redirect: 'follow'
    });
    return loginRes.headers.get("set-cookie");
  }

  const cfUserRecord = request.headers.get('Cf-Access-Authenticated-User-Email');

  // Handle Authentication Request
  if (request.method === "POST" && path === "auth") {
    const body = await request.json();

    if (body.type === 'admin') {
      if (cfUserRecord) {
        return new Response(JSON.stringify({ success: true, role: 'admin', msg: 'Cloudflare Zero Trust Authenticated' }), {
          headers: { "Content-Type": "application/json" }
        });
      }
      if (body.username === ADMIN_USER && body.password === ADMIN_PASS) {
        return new Response(JSON.stringify({ success: true, role: 'admin' }), {
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ success: false, msg: 'Invalid admin credentials' }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (body.type === 'client') {
      try {
        const cookie = await getSession();
        if (!cookie) {
          return new Response(JSON.stringify({ success: false, msg: 'Panel Auth Failed' }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
          });
        }

        // Correct endpoint: /panel/api/inbounds/list
        const apiRes = await fetch(`${PANEL_URL}/panel/api/inbounds/list`, {
          headers: { "Cookie": cookie }
        });
        const data = await apiRes.json();

        if (data && data.success && Array.isArray(data.obj)) {
          let foundClient = null;
          data.obj.forEach(inb => {
            if (inb.clientStats) {
              const client = inb.clientStats.find(c => c.email === body.id);
              if (client) foundClient = client;
            }
          });

          if (foundClient) {
            // Enrich with online status + IP list (no admin token needed on client check)
            let isOnline = null;
            let ips = [];

            try {
              const onRes = await fetch(`${PANEL_URL}/panel/api/inbounds/onlines`, {
                method: 'POST',
                headers: { "Cookie": cookie, "Content-Type": "application/json" },
                body: JSON.stringify({})
              });
              const onData = await onRes.json();
              if (onData && onData.success && Array.isArray(onData.obj)) {
                isOnline = onData.obj.includes(foundClient.email);
              }
            } catch (e) {}

            try {
              const ipRes = await fetch(`${PANEL_URL}/panel/api/inbounds/clientIps/${encodeURIComponent(foundClient.email)}`, {
                method: 'POST',
                headers: { "Cookie": cookie, "Content-Type": "application/json" },
                body: JSON.stringify({})
              });
              const ipData = await ipRes.json();
              if (ipData && ipData.success && Array.isArray(ipData.obj)) {
                ips = ipData.obj;
              }
            } catch (e) {}

            // Build subscription link + VLESS link
            let subLink = null;
            let vlessLink = null;
            try {
              const host = new URL(PANEL_URL).hostname;
              // default sub endpoint from your panel setup
              subLink = `https://${host}:7262/sub/nope/${foundClient.subId}`;

              // find inbound to build vless
              const inbound = data.obj.find(x => Number(x.id) === Number(foundClient.inboundId));
              if (inbound) {
                const stream = JSON.parse(inbound.streamSettings || '{}');
                const port = inbound.port;
                const remark = inbound.remark || port;
                const network = stream.network || 'ws';
                const security = stream.security || 'none';

                let qs = new URLSearchParams();
                qs.set('type', network);
                qs.set('encryption', 'none');

                if (network === 'ws') {
                  const ws = stream.wsSettings || {};
                  qs.set('path', ws.path || '/');
                  // host header for ws
                  const wsHost = ws.host || inbound?.host || host;
                  qs.set('host', wsHost);
                }

                if (security === 'tls') {
                  qs.set('security', 'tls');
                  const tls = stream.tlsSettings || {};
                  const sni = tls.serverName || host;
                  qs.set('sni', sni);
                  const alpn = Array.isArray(tls.alpn) ? tls.alpn.join(',') : '';
                  if (alpn) qs.set('alpn', alpn);
                  const fp = tls.settings?.fingerprint || 'chrome';
                  if (fp) qs.set('fp', fp);
                }

                vlessLink = `vless://${foundClient.uuid}@${host}:${port}?${qs.toString()}#${encodeURIComponent(`${remark}-${foundClient.email}`)}`;
              }
            } catch (e) {}

            return new Response(JSON.stringify({
              success: true,
              role: 'client',
              clientData: { ...foundClient, isOnline, ips, subLink, vlessLink }
            }), {
              headers: { "Content-Type": "application/json" }
            });
          }
        }

        return new Response(JSON.stringify({ success: false, msg: 'User email not found' }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, msg: 'Server connectivity error' }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
  }

  // Settings endpoint (Cloudflare Pages: env-var based, not writable)
  if (path === "settings") {
    if (request.method === "GET") {
      return new Response(JSON.stringify({
        panelUrl: PANEL_URL,
        username: ADMIN_USER,
        password: ""
      }), { headers: { "Content-Type": "application/json" } });
    }
    if (request.method === "POST") {
      return new Response(JSON.stringify({
        success: false,
        msg: "Read-only on Cloudflare Pages. Set PANEL_URL / PANEL_USERNAME / PANEL_PASSWORD in Pages environment variables."
      }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
  }

  // Require Admin Auth for other requests
  const authHeader = request.headers.get('Authorization');
  const isZeroTrustAdmin = !!cfUserRecord;
  if (authHeader !== `Bearer ${ADMIN_PASS}` && !isZeroTrustAdmin) {
    return new Response(JSON.stringify({ success: false, msg: 'Unauthorized' }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  // Admin routes
  try {
    const cookie = await getSession();
    if (!cookie) {
      return new Response(JSON.stringify({ success: false, msg: "Panel Auth Failed" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Generic proxy for ALL endpoints from the official API documentation.
    // Usage: /api/xui/<path>  ->  ${PANEL_URL}/panel/api/<path>
    // Example: /api/xui/server/status -> /panel/api/server/status
    if (path.startsWith('xui/')) {
      const subPath = path.slice(4).replace(/^\/+/, '');
      const targetUrl = `${PANEL_URL}/panel/api/${subPath}`;

      const headers = {
        "Cookie": cookie,
        "Accept": "application/json",
        "Referer": `${PANEL_URL}/`
      };

      // Forward Content-Type if present
      const ct = request.headers.get('Content-Type');
      if (ct) headers['Content-Type'] = ct;

      let body;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        // If it's JSON, keep it as text to forward cleanly.
        body = await request.text();
      }

      const proxied = await fetch(targetUrl, {
        method: request.method,
        headers,
        body
      });

      const text = await proxied.text();
      return new Response(text, {
        status: proxied.status,
        headers: { "Content-Type": proxied.headers.get('Content-Type') || 'application/json' }
      });
    }

    const fetchInbounds = async () => {
      const apiRes = await fetch(`${PANEL_URL}/panel/api/inbounds/list`, {
        method: "GET",
        headers: {
          "Cookie": cookie,
          "Accept": "application/json",
          "Referer": `${PANEL_URL}/`
        }
      });
      return await apiRes.json();
    };

    if (path === "system-history") {
      const points = Array.from({ length: 10 }, (_, i) => ({
        time: `${i}:00`,
        cpu: 0,
        ram: 0
      }));
      return new Response(JSON.stringify({ success: true, obj: points }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (path === "clients") {
      const data = await fetchInbounds();
      const clients = [];
      if (data && data.obj) {
        data.obj.forEach(inb => {
          if (inb.clientStats) {
            inb.clientStats.forEach(c => clients.push({ ...c, inboundId: inb.id }));
          }
        });
      }
      return new Response(JSON.stringify({ success: true, obj: clients }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    let targetUrl = "";
    if (path === "status") targetUrl = `${PANEL_URL}/panel/api/server/status`;
    else if (path === "inbounds") targetUrl = `${PANEL_URL}/panel/api/inbounds/list`;
    else if (path === "history") {
      return new Response(JSON.stringify({
        success: true,
        obj: { dates: ['M', 'T', 'W', 'T', 'F', 'S', 'S'], up: [1, 2, 3, 2, 4, 5, 8], down: [10, 15, 12, 18, 20, 25, 30] }
      }), { headers: { "Content-Type": "application/json" } });
    } else {
      return new Response(JSON.stringify({ success: false, msg: "Endpoint not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }

    const apiRes = await fetch(targetUrl, {
      method: "GET",
      headers: {
        "Cookie": cookie,
        "Accept": "application/json",
        "Referer": `${PANEL_URL}/`
      }
    });

    const data = await apiRes.json();

    // If request came from a browser navigation to /api/status, redirect back to UI
    // so Access auth flow works smoothly.
    const accept = request.headers.get('Accept') || '';
    const secFetchDest = request.headers.get('Sec-Fetch-Dest') || '';
    const isNav = accept.includes('text/html') || secFetchDest === 'document';
    if (path === 'status' && isNav) {
      return Response.redirect(`${url.origin}/?admin=1`, 302);
    }

    return new Response(JSON.stringify({ success: true, obj: data.obj || data }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
