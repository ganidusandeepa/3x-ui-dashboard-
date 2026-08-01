function parseMaybe(v, fallback) {
  if (v == null || v === '') return fallback || {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return fallback || {}; }
}
function normIp(x) {
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object') return x.ip || x.address || x.clientIp || x.remote || '';
  return '';
}

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
    let foundInbound = null;
    data.obj.forEach(inb => {
      if (inb.clientStats) {
        const client = inb.clientStats.find(c => c.email === body.id);
        if (client) { foundClient = client; foundInbound = inb; }
      }
    });

    if (!foundClient) {
      return new Response(JSON.stringify({ success: false, msg: 'User email not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Resolve UUID from inbound settings.clients if missing in clientStats
    let resolvedUuid = foundClient.uuid;
    if (!resolvedUuid && foundInbound) {
      try {
        const inbSettings = parseMaybe(foundInbound.settings);
        const clientConf = (inbSettings.clients || []).find(c => c.email === foundClient.email);
        resolvedUuid = clientConf?.id || null;
      } catch (e) {}
    }

    // Enrich: online status + IPs + links
    let isOnline = null;
    let ips = [];
    let subLink = null;
    let vlessLink = null;

    try {
      for (const p of ['clients/onlines', 'inbounds/onlines']) {
        try {
          const onRes = await fetch(`${PANEL_URL}/panel/api/${p}`, {
            method: 'POST',
            headers: { "Cookie": cookie, "Content-Type": "application/json" },
            body: JSON.stringify({})
          });
          const onData = await onRes.json();
          if (onData && onData.success && Array.isArray(onData.obj)) {
            isOnline = onData.obj.includes(foundClient.email);
            break;
          }
        } catch (e) {}
      }
    } catch (e) {}

    try {
      const em = encodeURIComponent(foundClient.email);
      for (const p of [`clients/ips/${em}`, `inbounds/clientIps/${em}`]) {
        try {
          const ipRes = await fetch(`${PANEL_URL}/panel/api/${p}`, {
            method: 'POST',
            headers: { "Cookie": cookie, "Content-Type": "application/json" },
            body: JSON.stringify({})
          });
          const ipData = await ipRes.json();
          if (ipData && ipData.success) {
            if (Array.isArray(ipData.obj)) { ips = ipData.obj.map(normIp).filter(Boolean); break; }
            if (typeof ipData.obj === 'string' && ipData.obj && !/no ip/i.test(ipData.obj)) {
              ips = ipData.obj.split(/[,\s]+/).filter(Boolean); break;
            }
          }
        } catch (e) {}
      }
    } catch (e) {}

    try {
      const host = new URL(PANEL_URL).hostname;
      subLink = foundClient.subId ? `${PANEL_URL}/sub/${foundClient.subId}` : null;

      if (foundInbound) {
        const stream = parseMaybe(foundInbound.streamSettings);
        const port = foundInbound.port;
        const remark = foundInbound.remark || String(port);
        const network = stream.network || 'tcp';
        const security = stream.security || 'none';

        let qs = new URLSearchParams();
        qs.set('type', network);
        qs.set('encryption', 'none');

        if (network === 'ws') {
          const ws = stream.wsSettings || {};
          qs.set('path', ws.path || '/');
          qs.set('host', ws.headers?.Host || ws.host || host);
        }

        if (security === 'tls') {
          qs.set('security', 'tls');
          const tls = stream.tlsSettings || {};
          qs.set('sni', tls.serverName || host);
          const alpn = Array.isArray(tls.alpn) ? tls.alpn.join(',') : '';
          if (alpn) qs.set('alpn', alpn);
          const fp = tls.settings?.fingerprint || '';
          if (fp) qs.set('fp', fp);
        }

        if (resolvedUuid) {
          vlessLink = `vless://${resolvedUuid}@${host}:${port}?${qs.toString()}#${encodeURIComponent(`${remark}-${foundClient.email}`)}`;
        }
      }
    } catch (e) {}

    return new Response(JSON.stringify({
      success: true,
      role: 'client',
      clientData: { ...foundClient, uuid: resolvedUuid, isOnline, subLink, vlessLink }
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
