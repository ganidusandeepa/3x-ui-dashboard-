export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  
  const PANEL_URL = env.PANEL_URL || "http://127.0.0.1:2053";
  const ADMIN_USER = env.PANEL_USERNAME || "admin";
  const ADMIN_PASS = env.PANEL_PASSWORD || "password";

  const path = url.pathname.replace('/api/', '');

  async function getSession() {
    const loginRes = await fetch(`${PANEL_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS })
    });
    return loginRes.headers.get("set-cookie");
  }

  const cfUserRecord = request.headers.get('Cf-Access-Authenticated-User-Email');

  // Handle Authentication Request
  if (request.method === "POST" && path === "auth") {
      const body = await request.json();
      if (body.type === 'admin') {
          if (cfUserRecord) {
              return new Response(JSON.stringify({ success: true, role: 'admin', msg: 'Cloudflare Zero Trust Authenticated' }));
          }
          if (body.username === ADMIN_USER && body.password === ADMIN_PASS) {
              return new Response(JSON.stringify({ success: true, role: 'admin' }));
          }
          return new Response(JSON.stringify({ success: false, msg: 'Invalid admin credentials' }), { status: 401 });
      } else if (body.type === 'client') {
          try {
              const cookie = await getSession();
              if(!cookie) return new Response(JSON.stringify({ success: false, msg: 'Panel Auth Failed' }), { status: 500 });
              
              const apiRes = await fetch(`${PANEL_URL}/panel/api/inbound/list`, { headers: { "Cookie": cookie } });
              const data = await apiRes.json();
              if(data.success) {
                  let foundClient = null;
                  data.obj.forEach(inb => {
                      if(inb.clientStats) {
                          const client = inb.clientStats.find(c => c.email === body.id);
                          if(client) foundClient = client;
                      }
                  });
                  if(foundClient) return new Response(JSON.stringify({ success: true, role: 'client', clientData: foundClient }));
              }
              return new Response(JSON.stringify({ success: false, msg: 'User email not found' }), { status: 404 });
          } catch(e) {
              return new Response(JSON.stringify({ success: false, msg: 'Server connectivity error' }), { status: 500 });
          }
      }
  }

  // Require Admin Auth for other requests
  const authHeader = request.headers.get('Authorization');
  const isZeroTrustAdmin = !!request.headers.get('Cf-Access-Authenticated-User-Email');
  if (path !== "settings" && authHeader !== `Bearer ${ADMIN_PASS}` && !isZeroTrustAdmin) {
      return new Response(JSON.stringify({ success: false, msg: 'Unauthorized' }), { status: 401 });
  }

  // Admin Routes
  try {
    const cookie = await getSession();
    if (!cookie) return new Response(JSON.stringify({ success: false, msg: "Panel Auth Failed" }), { status: 401 });

    let targetUrl = "";
    if (path === "status") targetUrl = `${PANEL_URL}/panel/api/server/status`;
    else if (path === "inbounds") targetUrl = `${PANEL_URL}/panel/api/inbound/list`;
    else if (path === "history") {
        return new Response(JSON.stringify({
            success: true,
            obj: { dates: ['M', 'T', 'W', 'T', 'F', 'S', 'S'], up: [1, 2, 3, 2, 4, 5, 8], down: [10, 15, 12, 18, 20, 25, 30] }
        }));
    } else {
        return new Response(JSON.stringify({ success: false, msg: "Endpoint not found" }));
    }

    const apiRes = await fetch(targetUrl, { method: "GET", headers: { "Cookie": cookie } });
    const data = await apiRes.json();
    return new Response(JSON.stringify({ success: true, obj: data.obj || data }), {
        headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}
