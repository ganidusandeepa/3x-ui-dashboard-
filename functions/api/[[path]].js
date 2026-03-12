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
            return new Response(JSON.stringify({ success: true, role: 'client', clientData: foundClient }), {
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
