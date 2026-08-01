// Module-level session cache (reused within the same worker instance lifecycle)
let _session = { cookie: null, ts: 0 };
const SESSION_TTL = 18 * 60 * 1000; // 18 min

// Newer 3x-ui can return settings/streamSettings/sniffing as nested objects
// instead of JSON strings — tolerate both so link building never throws.
function parseMaybe(v, fallback) {
  if (v == null || v === '') return fallback || {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return fallback || {}; }
}
// Normalize a client-IPs response entry (string or {ip}/{address}) to a string.
function normIp(x) {
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object') return x.ip || x.address || x.clientIp || x.remote || '';
  return '';
}

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
  const PANEL_API_TOKEN = env.PANEL_API_TOKEN || null;

  const path = url.pathname.replace('/api/', '');

  async function getSession() {
    // If using API token, return it directly (no session needed)
    if (PANEL_API_TOKEN) {
      return `Bearer ${PANEL_API_TOKEN}`;
    }

    const now = Date.now();
    if (_session.cookie && (now - _session.ts) < SESSION_TTL) {
      return _session.cookie;
    }

    try {
      // Try 3x-ui 3.6.0+ API first (JSON endpoint)
      const loginRes = await fetch(`${PANEL_URL}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
        redirect: 'follow'
      });

      const cookie = loginRes.headers.get("set-cookie");
      if (cookie) {
        _session = { cookie, ts: now };
        return cookie;
      }

      const data = await loginRes.json().catch(() => null);
      if (data?.success && cookie) {
        return cookie;
      }
    } catch (e) {}

    try {
      // Fallback to old /login endpoint (form-encoded)
      const loginRes = await fetch(`${PANEL_URL}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASS }),
        redirect: 'follow'
      });
      const cookie = loginRes.headers.get("set-cookie");
      if (cookie) {
        _session = { cookie, ts: now };
        return cookie;
      }
    } catch (e) {}

    return null;
  }

  const cfUserRecord = request.headers.get('Cf-Access-Authenticated-User-Email');

  // Helper to add auth to headers (supports both cookie and Bearer token)
  function authHeaders(baseHeaders = {}) {
    if (PANEL_API_TOKEN) {
      return { ...baseHeaders, "Authorization": `Bearer ${PANEL_API_TOKEN}` };
    }
    return baseHeaders;
  }

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

        const headers = PANEL_API_TOKEN
          ? { "Authorization": `Bearer ${PANEL_API_TOKEN}` }
          : { "Cookie": cookie };
        const apiRes = await fetch(`${PANEL_URL}/panel/api/inbounds/list`, {
          headers
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
              const onHeaders = PANEL_API_TOKEN
                ? { "Authorization": `Bearer ${PANEL_API_TOKEN}`, "Content-Type": "application/json" }
                : { "Cookie": cookie, "Content-Type": "application/json" };
              // 3x-ui moved this to /panel/api/clients/onlines; fall back to the
              // legacy /panel/api/inbounds/onlines for older panels.
              for (const p of ['clients/onlines', 'inbounds/onlines']) {
                try {
                  const onRes = await fetch(`${PANEL_URL}/panel/api/${p}`, {
                    method: 'POST', headers: onHeaders, body: JSON.stringify({})
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
              const ipHeaders = PANEL_API_TOKEN
                ? { "Authorization": `Bearer ${PANEL_API_TOKEN}`, "Content-Type": "application/json" }
                : { "Cookie": cookie, "Content-Type": "application/json" };
              const em = encodeURIComponent(foundClient.email);
              // New API: /panel/api/clients/ips/{email}; legacy: /panel/api/inbounds/clientIps/{email}
              for (const p of [`clients/ips/${em}`, `inbounds/clientIps/${em}`]) {
                try {
                  const ipRes = await fetch(`${PANEL_URL}/panel/api/${p}`, {
                    method: 'POST', headers: ipHeaders, body: JSON.stringify({})
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

            // New client-scoped extras: every config link across inbounds, all
            // subscription protocol links, and an accurate last-seen timestamp.
            let allLinks = [];
            let subProtoLinks = [];
            let lastOnlineTs = 0;
            const getHdr = PANEL_API_TOKEN
              ? { "Authorization": `Bearer ${PANEL_API_TOKEN}`, "Accept": "application/json" }
              : { "Cookie": cookie, "Accept": "application/json" };
            const postHdr = PANEL_API_TOKEN
              ? { "Authorization": `Bearer ${PANEL_API_TOKEN}`, "Content-Type": "application/json" }
              : { "Cookie": cookie, "Content-Type": "application/json" };
            const normLinks = (obj) => Array.isArray(obj) ? obj.map(x => {
              if (typeof x === 'string') return { remark: '', link: x };
              if (x && typeof x === 'object') return { remark: x.remark || x.name || x.tag || '', link: x.link || x.url || x.uri || '' };
              return null;
            }).filter(x => x && x.link) : [];

            try {
              const r = await fetch(`${PANEL_URL}/panel/api/clients/links/${encodeURIComponent(foundClient.email)}`, { headers: getHdr });
              const j = await r.json();
              if (j && j.success) allLinks = normLinks(j.obj);
            } catch (e) {}

            try {
              if (foundClient.subId) {
                const r = await fetch(`${PANEL_URL}/panel/api/clients/subLinks/${encodeURIComponent(foundClient.subId)}`, { headers: getHdr });
                const j = await r.json();
                if (j && j.success && Array.isArray(j.obj)) {
                  subProtoLinks = j.obj.map(x => typeof x === 'string' ? x : (x && (x.link || x.url || x.uri))).filter(Boolean);
                }
              }
            } catch (e) {}

            try {
              const r = await fetch(`${PANEL_URL}/panel/api/clients/lastOnline`, { method: 'POST', headers: postHdr, body: JSON.stringify({}) });
              const j = await r.json();
              if (j && j.success && j.obj && typeof j.obj === 'object') {
                let ts = Number(j.obj[foundClient.email] || 0);
                if (ts > 0 && ts < 1e12) ts *= 1000; // seconds -> ms
                lastOnlineTs = ts || 0;
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
                const stream = parseMaybe(foundInbound.streamSettings);
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
                    qs.set('path', ws.path || '/');
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
                  const settings = parseMaybe(foundInbound.settings);
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

            // Fetch subscription ?format=info for period usage + live status
            let subInfo = null;
            if (subLink) {
              try {
                const siRes = await fetch(`${subLink}?format=info`, {
                  headers: { Cookie: cookie, 'User-Agent': 'ClashforWindows/0.20.0' }
                });
                const sct = siRes.headers.get('content-type') || '';
                if (sct.includes('json')) {
                  const sj = await siRes.json().catch(() => null);
                  if (sj && (sj.upload !== undefined || sj.download !== undefined)) subInfo = sj;
                }
                if (!subInfo) {
                  const hdr = siRes.headers.get('Subscription-Userinfo') || '';
                  if (hdr) {
                    subInfo = {};
                    hdr.split(';').forEach(p => {
                      const [k, v] = p.trim().split('=');
                      if (k && v !== undefined) subInfo[k.trim()] = Number(v.trim());
                    });
                  }
                }
              } catch (e) {}
            }

            return new Response(JSON.stringify({
              success: true,
              role: 'client',
              clientData: { ...foundClient, isOnline, ips, subLink, vlessLink, vmessLink, trojanLink, configLink, protocol, subInfo, allLinks, subProtoLinks, lastOnlineTs }
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

  // Public ping endpoint — measures worker→panel latency
  if (path === "ping" && request.method === "GET") {
    const t0 = Date.now();
    try {
      await fetch(`${PANEL_URL}/`, { method: 'HEAD', signal: AbortSignal.timeout(6000) });
    } catch (e) {}
    const latency = Date.now() - t0;
    return new Response(JSON.stringify({ latency, ts: t0 }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
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

  // Settings — read-only (returns env-backed values, no cookie needed)
  if (path === "settings" && request.method === "GET") {
    return new Response(JSON.stringify({ success: true, panelUrl: PANEL_URL, username: ADMIN_USER }), {
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
        ...(PANEL_API_TOKEN ? { "Authorization": `Bearer ${PANEL_API_TOKEN}` } : { "Cookie": cookie }),
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
        headers: {
          ...(PANEL_API_TOKEN ? { "Authorization": `Bearer ${PANEL_API_TOKEN}` } : { "Cookie": cookie }),
          "Accept": "application/json",
          "Referer": `${PANEL_URL}/`
        }
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
      headers: {
        ...(PANEL_API_TOKEN ? { "Authorization": `Bearer ${PANEL_API_TOKEN}` } : { "Cookie": cookie }),
        "Accept": "application/json",
        "Referer": `${PANEL_URL}/`
      }
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
