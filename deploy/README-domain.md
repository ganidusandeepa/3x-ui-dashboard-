# Serving the dashboard on your domain with HTTPS

Your VPS runs Xray on port **443**, so the dashboard cannot bind 443 and
`certbot --nginx` cannot work (its HTTP-01 → HTTPS flow expects 443). The
supported setup instead lets **Cloudflare terminate TLS at the edge**:

```
browser --HTTPS--> Cloudflare (edge cert) --HTTP:80--> nginx --> dashboard container
```

Xray keeps 443 the whole time.

## Setup

```bash
sudo bash deploy/setup-domain.sh dashboard.trackydev.site 127.0.0.1:8090
```

Then in Cloudflare:

1. **DNS** → `A` record for your subdomain → VPS public IP → **Proxied (orange cloud)**
2. **SSL/TLS → Overview → Flexible**
3. Open `https://dashboard.trackydev.site`

> Leave the **Domain** field empty in Coolify. nginx owns port 80, so Coolify's
> proxy can't also bind it — nginx is doing the routing.

## Why "Flexible" specifically

| Cloudflare mode | Origin port it connects to | Result here |
|---|---|---|
| Full / Full (strict) | **443** | Hits **Xray**, not the dashboard → error 525/526 |
| **Flexible** | **80** | Reaches nginx → dashboard ✅ |

## Troubleshooting

| Symptom | Cause |
|---|---|
| Cloudflare error 521/522 | Nothing listening on :80, or a firewall blocks it |
| Cloudflare error 525/526 | SSL mode is Full/Strict → change to Flexible |
| "Welcome to nginx" page | The default site is shadowing ours; the script removes it |
| 404 | nginx has no `server_name` match for that hostname — re-run the script with the right domain |
| Changes seem ignored | nginx is running **outside systemd** with a stale config. The script detects and fixes this |
| 502 Bad Gateway | The container isn't up on the upstream (`curl http://127.0.0.1:8090/`) |

## Upgrading to full encryption (optional, recommended)

Flexible leaves the **Cloudflare → origin** hop unencrypted. That traffic
carries client config links containing VPN UUIDs, so if you'd rather encrypt it
end to end, use a Cloudflare **Origin Certificate** on a spare HTTPS port.

Cloudflare only connects to origins on these HTTPS ports: `443, 2053, 2083,
2087, 2096, 8443`. 443 is taken by Xray, so use **8443**.

1. **Cloudflare → SSL/TLS → Origin Server → Create Certificate.** Save the cert
   and key on the VPS:
   ```bash
   sudo mkdir -p /etc/ssl/cloudflare
   sudo nano /etc/ssl/cloudflare/origin.pem   # paste the certificate
   sudo nano /etc/ssl/cloudflare/origin.key   # paste the private key
   sudo chmod 600 /etc/ssl/cloudflare/origin.key
   ```

2. Add an HTTPS server block on 8443 (keep the port-80 one; Cloudflare may
   still use it for redirects):
   ```nginx
   server {
       listen 8443 ssl;
       http2 on;
       server_name dashboard.trackydev.site;

       ssl_certificate     /etc/ssl/cloudflare/origin.pem;
       ssl_certificate_key /etc/ssl/cloudflare/origin.key;

       client_max_body_size 64m;

       location / {
           proxy_pass http://xui_dashboard;
           proxy_http_version 1.1;
           proxy_set_header Host              $host;
           proxy_set_header X-Real-IP         $remote_addr;
           proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto https;

           # SSE must not be buffered
           proxy_set_header Connection "";
           proxy_buffering           off;
           proxy_cache               off;
           chunked_transfer_encoding off;
           proxy_read_timeout        3600s;
           proxy_send_timeout        3600s;
       }
   }
   ```
   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

3. **Cloudflare → Rules → Origin Rules → Create**: for hostname
   `dashboard.trackydev.site`, *Rewrite to* → **Port 8443**.

4. **Cloudflare → SSL/TLS → Overview → Full (strict).**

Now every hop is encrypted, and Xray still owns 443.
