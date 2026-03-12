export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  
  // Get credentials from Environment Variables (Recommended for Cloudflare)
  // Or fallback to dummy values if not set yet
  const PANEL_URL = env.PANEL_URL || "http://YOUR_IP:PORT";
  const USERNAME = env.PANEL_USERNAME || "admin";
  const PASSWORD = env.PANEL_PASSWORD || "password";

  // Identify which API endpoint is being called
  const path = url.pathname.replace('/api/', '');

  // 1. Handle Login to get Session Cookie
  async function getSession() {
    const loginRes = await fetch(`${PANEL_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: USERNAME, password: PASSWORD })
    });
    return loginRes.headers.get("set-cookie");
  }

  // 2. Proxy Logic
  try {
    const cookie = await getSession();
    if (!cookie) return new Response(JSON.stringify({ success: false, msg: "Auth Failed" }), { status: 401 });

    let targetUrl = "";
    if (path === "status") targetUrl = `${PANEL_URL}/panel/api/server/status`;
    else if (path === "inbounds") targetUrl = `${PANEL_URL}/panel/api/inbound/list`;
    else if (path === "history") {
        return new Response(JSON.stringify({
            success: true,
            obj: {
                dates: ['M', 'T', 'W', 'T', 'F', 'S', 'S'],
                up: [1, 2, 3, 2, 4, 5, 8],
                down: [10, 15, 12, 18, 20, 25, 30]
            }
        }));
    } else {
        return new Response(JSON.stringify({ success: false, msg: "Endpoint not mapped" }));
    }

    const apiRes = await fetch(targetUrl, {
      method: "GET",
      headers: { "Cookie": cookie }
    });
    
    const data = await apiRes.json();
    return new Response(JSON.stringify({ success: true, obj: data.obj || data }), {
        headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}
