# Hosting: DNS, Cloudflare and Vercel

**Status:** current (2026-10-27). Live at `https://minard.lsquared.cc`.

How a request reaches the site, what each service is responsible for, and how
to check or undo each piece.

## The path of a request

```
visitor ──HTTPS──▶ Cloudflare edge ──HTTPS (Full strict)──▶ Vercel ──▶ web/dist
                   (proxy + cache)                           (build + origin)
```

| Layer | Service | What it does here |
|---|---|---|
| Registrar | Cloudflare Registrar | Owns `lsquared.cc`; transfer lock, WHOIS privacy, auto-renew |
| DNS | Cloudflare DNS | Answers for `lsquared.cc`, signed with DNSSEC |
| Edge | Cloudflare proxy (orange cloud on `minard`) | TLS to visitors, HTTP → HTTPS, caches `/assets/*` |
| Origin | Vercel project `cr-flow-map` (team `lsquareds-projects`) | Builds `web/` on pushes to `main`, serves the page and headers |
| Analytics | Google Analytics 4, `G-Z5R7L1HYS1` | Loaded only on `minard.lsquared.cc` (`web/src/lib/analytics.ts`) |

Why Cloudflare is in front: the data pack is ~3–5 MB per visit and every pack
file is content-hashed and `immutable`, so Cloudflare serves almost all bytes
from its cache. Vercel sends only the ~0.1 MB page per visit, which keeps a
traffic spike inside the Vercel Hobby bandwidth allowance.

## Cloudflare

### DNS records (`lsquared.cc`)

| Type | Name | Value | Proxy | Purpose |
|---|---|---|---|---|
| CNAME | `minard` | `c5841a8151df2015.vercel-dns-017.com` | **Proxied** | the site (target given by Vercel) |
| TXT | `@` | `v=spf1 -all` | | no mail is sent from this domain |
| TXT | `_dmarc` | `v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s` | | reject spoofed mail |
| TXT | `*._domainkey` | `v=DKIM1; p=` | | no DKIM keys, so any signature fails |
| MX | `@` | `.` (priority 0) | | null MX (RFC 7505): no mail accepted |
| CAA | `@` | `0 issue "letsencrypt.org"`, `0 issuewild ";"` | | only Let's Encrypt (Vercel) may issue |

While Universal SSL is on (it must be, for the proxy), Cloudflare adds CAA
entries for its own CAs automatically; they do not show in the DNS list.
DNSSEC is on (DNS → Settings); the registry shows `signedDelegation`.

If the domain ever starts sending mail, the SPF / DMARC / MX / DKIM records
above must be replaced with the mail provider's.

### Zone settings

| Setting | Value | Why |
|---|---|---|
| SSL/TLS mode | **Full (strict)** | Cloudflare checks Vercel's certificate; "Flexible" would loop redirects |
| Minimum TLS | 1.2 | |
| Always Use HTTPS | on | HTTP → HTTPS (301) at the edge |
| Automatic HTTPS Rewrites | **off** | it rewrites `http://` text in the page, including inside the inline bundle, which breaks the CSP hash and blanks the site |
| Email Obfuscation | **off** | injects a script into the page |
| Server-side Excludes | off | page rewriter |
| Rocket Loader | **off** | rewrites scripts; breaks the app and the CSP |
| Web Analytics (RUM) | **off** | injects `static.cloudflareinsights.com/beacon.min.js`, which the CSP blocks |

Rule of thumb: nothing at Cloudflare may modify the HTML. The page carries a
Content Security Policy that allows the two inline scripts by SHA-256 hash
only, so any injected or rewritten script is blocked (see "Checks" below).

### Cache rule

Caching → Cache Rules, one rule:

- **If** `http.host eq "minard.lsquared.cc" and starts_with(http.request.uri.path, "/assets/")`
- **Then** eligible for cache; edge TTL and browser TTL: respect origin
  (Vercel sends `public, max-age=31536000, immutable` for `/assets/*`).

The page itself (`/`, `index.html`) is not cached at the edge (Vercel sends
`max-age=0, must-revalidate`), so a deploy is visible at once. Nothing else is
cached, including `/.well-known/acme-challenge/*`, so Vercel's certificate
renewal reaches Vercel.

## Vercel

- Project `cr-flow-map`, root `web/`, config `web/vercel.json` (build command,
  headers, deploy rules).
- Domains: `minard.lsquared.cc` (production). The old
  `china-rail-flow-map-web.vercel.app` redirects there permanently
  (`redirects` in `web/vercel.json`, path and query kept; the source is
  `/(.*)` because Vercel's `/:path*` does not match the bare `/`).
- Certificate: Let's Encrypt for `minard.lsquared.cc`, issued and renewed by
  Vercel (`vercel certs ls --scope lsquareds-projects`).
- Deploys: `main` builds when `web/` changes; `deckgl` previews build only on
  `[deploy]` commits (`ignoreCommand` in `web/vercel.json`). Preview URLs
  require a Vercel login.
- Headers set in `web/vercel.json`: HSTS (Vercel), `X-Content-Type-Options`,
  `Referrer-Policy`, `Permissions-Policy`, `frame-ancestors 'self'`,
  `X-Frame-Options`, `Cross-Origin-Opener-Policy`, cache and `Content-Encoding`
  headers for the `.br` packs. The rest of the CSP is a `<meta>` tag written by
  `web/bundle.mjs`.
- Firewall: Vercel's automatic DDoS mitigation only. Repeated automated
  requests to one host (polling with `curl`) can trigger its "Security
  Checkpoint" challenge for that client; browsers pass it, scripts do not.

## If the domain or host changes

1. `PROD_HOST` in `web/src/lib/analytics.ts` (otherwise analytics stops).
2. `og:url`, `og:image`, `twitter:*` in `web/index.template.html`.
3. The redirect in `web/vercel.json`, the README link and the GitHub repo
   homepage.
4. The GA4 data stream URL (a label only).

## Checks

```bash
# DNS and DNSSEC
dig +short minard.lsquared.cc @1.1.1.1          # Cloudflare addresses while proxied
whois lsquared.cc | grep -i dnssec               # signedDelegation

# Headers through Cloudflare
curl -sI https://minard.lsquared.cc/ | grep -iE 'server|cf-cache|content-security|strict-transport'

# The page must be byte-identical to Vercel's, also for a browser user agent
# (a Cloudflare feature that rewrites HTML shows up here first)
UA='Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130.0 Safari/537.36'
curl -s --compressed -A "$UA" -H 'Accept: text/html' https://minard.lsquared.cc/ | grep -c cloudflareinsights   # 0

# Asset caching: MISS once per Cloudflare location, then HIT
curl -sI https://minard.lsquared.cc/assets/<hashed file> | grep -i cf-cache-status
```

In a browser, the console must show no "Content Security Policy" errors.

## Undo

- **Take Cloudflare out of the path:** DNS → `minard` → set to "DNS only"
  (grey cloud). Visitors reach Vercel directly within seconds; nothing else
  changes. Do this first if the site misbehaves only behind Cloudflare.
- **Purge Cloudflare's cache:** Caching → Configuration → Purge Everything
  (rarely needed: asset names change with their content).
- **Leave the custom domain:** revert the domain PR (#145); the redirect goes
  with it and `china-rail-flow-map-web.vercel.app` serves directly again.

## Account security

- Cloudflare, Vercel, GitHub and Google: 2FA with a passkey or security key;
  the email account that recovers all of them matters most.
- Cloudflare API tokens: scoped to one zone, short expiry, deleted after use.
  The Vercel CLI login is a full-account token: `vercel logout` after use.
- If the Vercel project or the domain is removed, delete the `minard` record
  too (a dangling record can be taken over).
