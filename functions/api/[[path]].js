// Module-level session cache (reused within the same worker instance lifecycle)
let _session = { cookie: null, ts: 0 };
const SESSION_TTL = 18 * 60 * 1000; // 18 min

// Rolling system history buffer (CPU/RAM over time)
let _sysHistory = [];
const HISTORY_MAX = 24;

function pushHistory(s) {
  try {
    const cpu = Number(s.cpu) || 0;
    const memCur = Number(s.mem?.current) || 0;
    const memTot = Number(s.mem?.total) || 1;
    const ram = memTot > 0 ? Math.round((memCur / memTot) * 100) : 0;
    _sysHistory.push({
      time: new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit' }),
      cpu: Math.round(Math.min(100, Math.max(0, cpu))),
      ram: Math.min(100, Math.max(0, ram))
    });
    if (_sysHistory.length > HISTORY_MAX) _sysHistory.shift();
  } catch (e) {}
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const PANEL_URL_RAW = env.PANEL_URL || "http://127.0.0.1:2053";
  const PANEL_URL = PANEL_URL_RAW.replace(/\/$/, "");
  const ADMIN_USER = env.PANEL_USERNAME || "admin";
  const ADMIN_PASS = env.PANEL_PASSWORD || "password";

  const path = url.pathname.replace('/api/', '');

  async function getSession() {
    const now = Date.now();
    if (_session.cookie && (now - _session.ts) < SESSION_TTL) {
      return _session.cookie;
    }
    const loginRes = await fetch(`${PANEL_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS }),
      redirect: 'follow'
    });
    const cookie = loginRes.headers.get("set-cookie");
    if (cookie) {
      _session = { cookie, ts: now };
    }
    return cookie;
  }

  const cfUserRecord = request.headers.get('Cf-Access-Authenticated-User-Email');

  // Authentication endpoint
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

        const apiRes = await fetch(`${PANEL_URL}/panel/api/inbounds/list`, {
          headers: { "Cookie": cookie }
        });
        const data = await apiRes.json();

        if (data && data.success && Array.isArray(data.obj)) {
          let foundClient = null;
          let foundInbound = null;
          data.obj.forEach(inb => {
            if (inb.clientStats) {
              const client = inb.clientStats.find(c => c.email === body.id);
              if (client) { foundClient = client; foundInbound = inb; }
            }
          });

          if (foundClient) {
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

            let subLink = null;
            let vlessLink = null;
            let vmessLink = null;
            let trojanLink = null;
            let protocol = 'vless';

            try {
              const host = new URL(PANEL_URL).hostname;
              subLink = foundClient.subId ? `${PANEL_URL}/sub/${foundClient.subId}` : null;

              if (foundInbound) {
                const stream = JSON.parse(foundInbound.streamSettings || '{}');
                const port = foundInbound.port;
                const remark = foundInbound.remark || String(port);
                const network = stream.network || 'tcp';
                const security = stream.security || 'none';
                protocol = (foundInbound.protocol || 'vless').toLowerCase();

                const buildQs = () => {
                  let qs = new URLSearchParams();
                  qs.set('type', network);

                  if (network === 'ws') {
                    const ws = stream.wsSettings || {};
                    qs.set('path', encodeURIComponent(ws.path || '/'));
                    qs.set('host', ws.headers?.Host || ws.host || host);
                  } else if (network === 'grpc') {
                    const grpc = stream.grpcSettings || {};
                    qs.set('serviceName', grpc.serviceName || '');
                    qs.set('mode', grpc.multiMode ? 'multi' : 'gun');
                  } else if (network === 'tcp') {
                    const tcp = stream.tcpSettings || {};
                    if (tcp.header?.type === 'http') {
                      qs.set('headerType', 'http');
                    }
                  }

                  if (security === 'tls') {
                    qs.set('security', 'tls');
                    const tls = stream.tlsSettings || {};
                    qs.set('sni', tls.serverName || host);
                    const alpn = Array.isArray(tls.alpn) ? tls.alpn.join(',') : '';
                    if (alpn) qs.set('alpn', alpn);
                    const fp = tls.settings?.fingerprint || '';
                    if (fp) qs.set('fp', fp);
                    if (tls.settings?.allowInsecure) qs.set('allowInsecure', '1');
                  } else if (security === 'reality') {
                    qs.set('security', 'reality');
                    const reality = stream.realitySettings || {};
                    qs.set('sni', (reality.serverNames || [])[0] || host);
                    qs.set('pbk', reality.publicKey || '');
                    if (reality.shortIds?.[0]) qs.set('sid', reality.shortIds[0]);
                    const fp = reality.settings?.fingerprint || 'chrome';
                    qs.set('fp', fp);
                  }
                  return qs;
                };

                if (protocol === 'vless') {
                  const qs = buildQs();
                  qs.set('encryption', 'none');
                  const settings = JSON.parse(foundInbound.settings || '{}');
                  const clientConf = (settings.clients || []).find(c => c.email === foundClient.email);
                  if (clientConf?.flow) qs.set('flow', clientConf.flow);
                  vlessLink = `vless://${foundClient.uuid}@${host}:${port}?${qs.toString()}#${encodeURIComponent(`${remark}-${foundClient.email}`)}`;
                } else if (protocol === 'vmess') {
                  const vmessObj = {
                    v: '2', ps: `${remark}-${foundClient.email}`, add: host,
                    port: String(port), id: foundClient.uuid, aid: '0',
                    scy: 'auto', net: network, type: 'none',
                    host: network === 'ws' ? (stream.wsSettings?.headers?.Host || host) : '',
                    path: network === 'ws' ? (stream.wsSettings?.path || '/') : '',
                    tls: security === 'tls' ? 'tls' : ''
                  };
                  vmessLink = `vmess://${btoa(JSON.stringify(vmessObj))}`;
                } else if (protocol === 'trojan') {
                  const qs = buildQs();
                  trojanLink = `trojan://${foundClient.password || foundClient.uuid}@${host}:${port}?${qs.toString()}#${encodeURIComponent(`${remark}-${foundClient.email}`)}`;
                }
              }
            } catch (e) {}

            const configLink = vlessLink || vmessLink || trojanLink || null;

            return new Response(JSON.stringify({
              success: true,
              role: 'client',
              clientData: { ...foundClient, isOnline, ips, subLink, vlessLink, vmessLink, trojanLink, configLink, protocol }
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

  // Settings endpoint
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

  // Admin auth check
  const authHeader = request.headers.get('Authorization');
  const hasEmailHeader = !!cfUserRecord;
  const hasJwtAssertion = !!request.headers.get('Cf-Access-Jwt-Assertion');
  const cookieHdr = request.headers.get('Cookie') || '';
  const hasCfAuthCookie = /(?:^|;\s*)CF_Authorization=/.test(cookieHdr);
  const isZeroTrustAdmin = hasEmailHeader || hasJwtAssertion || hasCfAuthCookie;

  if (authHeader !== `Bearer ${ADMIN_PASS}` && !isZeroTrustAdmin) {
    return new Response(JSON.stringify({ success: false, msg: 'Unauthorized' }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const cookie = await getSession();
    if (!cookie) {
      return new Response(JSON.stringify({ success: false, msg: "Panel Auth Failed" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Generic proxy for all 3x-ui API endpoints
    if (path.startsWith('xui/')) {
      const subPath = path.slice(4).replace(/^\/+/, '');
      const targetUrl = `${PANEL_URL}/panel/api/${subPath}`;

      const headers = {
        "Cookie": cookie,
        "Accept": "application/json",
        "Referer": `${PANEL_URL}/`
      };

      const ct = request.headers.get('Content-Type');
      if (ct) headers['Content-Type'] = ct;

      let body;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const isBinary = ct && (ct.includes('multipart/form-data') || ct.includes('application/octet-stream'));
        if (isBinary) {
          body = await request.arrayBuffer();
          // For multipart, DO NOT set Content-Type manually — keep the browser-set boundary
        } else {
          body = await request.text();
        }
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
        headers: { "Cookie": cookie, "Accept": "application/json", "Referer": `${PANEL_URL}/` }
      });
      return await apiRes.json();
    };

    // Expiry alerts — clients expiring within 30 days
    if (path === "expiry-alerts") {
      const data = await fetchInbounds();
      const alerts = [];
      const now = Date.now();
      const WARN_30 = 30 * 24 * 60 * 60 * 1000;

      if (data && data.obj) {
        data.obj.forEach(inb => {
          if (inb.clientStats) {
            inb.clientStats.forEach(c => {
              const exp = Number(c.expiryTime);
              if (exp > 0) {
                const diff = exp - now;
                if (diff <= WARN_30) {
                  alerts.push({
                    email: c.email,
                    expiryTime: exp,
                    daysLeft: Math.ceil(diff / (24 * 60 * 60 * 1000)),
                    enable: c.enable,
                    inboundId: inb.id,
                    inboundRemark: inb.remark || String(inb.id)
                  });
                }
              }
            });
          }
        });
      }
      alerts.sort((a, b) => a.expiryTime - b.expiryTime);
      return new Response(JSON.stringify({ success: true, obj: alerts }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // System history — rolling real data
    if (path === "system-history") {
      const points = [];
      for (let i = 0; i < 10; i++) {
        const idx = _sysHistory.length - 10 + i;
        points.push(idx >= 0 ? _sysHistory[idx] : { time: '', cpu: 0, ram: 0 });
      }
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
            inb.clientStats.forEach(c => clients.push({ ...c, inboundId: inb.id, inboundRemark: inb.remark || String(inb.id), protocol: inb.protocol }));
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
      headers: { "Cookie": cookie, "Accept": "application/json", "Referer": `${PANEL_URL}/` }
    });

    const data = await apiRes.json();

    // Feed status data into rolling history buffer
    if (path === "status" && data && data.obj) {
      pushHistory(data.obj);
    }

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
    // Invalidate cached session on error so next request re-authenticates
    _session = { cookie: null, ts: 0 };
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
