export async function onRequestPost(context) {
  const { request, env } = context;

  const PANEL_URL_RAW = env.PANEL_URL || "http://127.0.0.1:2053";
  const PANEL_URL = PANEL_URL_RAW.replace(/\/$/, "");
  const ADMIN_USER = env.PANEL_USERNAME || "admin";
  const ADMIN_PASS = env.PANEL_PASSWORD || "password";

  async function getSession() {
    const loginRes = await fetch(`${PANEL_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS }),
      redirect: 'follow'
    });
    return loginRes.headers.get("set-cookie");
  }

  try {
    const body = await request.json();
    if (!body || body.type !== 'client') {
      return new Response(JSON.stringify({ success: false, msg: 'Unsupported' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const cookie = await getSession();
    if (!cookie) {
      return new Response(JSON.stringify({ success: false, msg: 'Panel Auth Failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const listRes = await fetch(`${PANEL_URL}/panel/api/inbounds/list`, {
      headers: { "Cookie": cookie }
    });
    const data = await listRes.json();

    if (!data || !data.success || !Array.isArray(data.obj)) {
      return new Response(JSON.stringify({ success: false, msg: 'Bad response from panel' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    let foundClient = null;
    data.obj.forEach(inb => {
      if (inb.clientStats) {
        const client = inb.clientStats.find(c => c.email === body.id);
        if (client) foundClient = client;
      }
    });

    if (!foundClient) {
      return new Response(JSON.stringify({ success: false, msg: 'User email not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Enrich: online status + IPs + links
    let isOnline = null;
    let ips = [];
    let subLink = null;
    let vlessLink = null;

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

    try {
      const host = new URL(PANEL_URL).hostname;
      subLink = `https://${host}:7262/sub/nope/${foundClient.subId}`;

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
          const wsHost = ws.host || host;
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
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (e) {
    return new Response(JSON.stringify({ success: false, msg: 'Bad request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
