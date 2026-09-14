---
name: authdeep-development
description: >
  Everything an AI coding agent needs to integrate AuthDeep without a browser —
  session login + CSRF, tenant/headless settings, users, gateway services,
  API keys (including notifications_email), SMTP/notification email config and
  templates, proxy S2S, frontend↔AuthDeep, backend↔gateway HMAC verification.
  Use when asked to add AuthDeep login, configure SMTP for signup/signin emails,
  create API keys, register services, send notification email, connect
  frontend/backend through the gateway, or self-host AuthDeep.
---

# AuthDeep Development (agent-first)

> Install: `curl -fsSL https://data.authdeep.com/skills/install.sh | sh -s gateway-integration`
> PowerShell: `iwr https://data.authdeep.com/skills/install.ps1 -useb | iex; Install-AuthDeepSkill gateway-integration`
> Stable URL: `https://data.authdeep.com/skills/gateway-integration`

This skill is the contract map for coding agents. Prefer **HTTP APIs** over the
admin UI when automating. Examples under `examples/` are the runnable source of
truth. **Pick the auth mode that matches the situation** — do not force one
pattern onto every use case.

### Decision matrix (all situations)

| Situation | Auth to use | Do not use |
|-----------|-------------|------------|
| End-user login in a browser / SPA | Session cookie `auth.sid` + CSRF (details: [browser-auth-integration](../browser-auth-integration/SKILL.md)) | `sak_` in the browser |
| Foreign-origin SPA (different eTLD+1 from AuthDeep) | Path B: `/api/auth/wt/*` → `wat_` + PoP (D1-B memory or D1-C Worker) | Shared cookies; `X-Session-Id`; `SameSite=None` |
| **Public self-service signup + login for YOUR customer-facing app** (blog, SaaS end users) | **Hosted auth redirect** — send the user to the tenant's hosted signup/login, which creates their account + membership and returns them. See [recipe G](#14-prompt-recipes-copy-paste) | A confidential OIDC client for the public — OIDC authorize requires the user to already be a tenant member, so public users get `access_denied` |
| Customer’s own login page (headless) | Headless login + CSRF (`white_label`) — see [browser-auth-integration](../browser-auth-integration/SKILL.md) | Hosted login assumptions; inventing `SameSite=None` |
| OIDC client (AuthDeep as IdP) | Only for **known, provisioned** users who are already tenant members | Public/self-registering end users — they are not members yet |
| One-time admin setup (SMTP, keys, services, users) | Admin session + CSRF **or** AuthDeep admin UI | Embedding admin password in an app |
| App backend sends transactional email | `sak_` + HMAC → `/api/gateway/notifications/email` | User password; `X-Internal-Secret` |
| Browser/mobile calling gateway APIs as a **human** | Path A cookie + CSRF, or Path B `wat_`+PoP | `sak_` / `ssk_` / `cak_` in the browser |
| Service A → Service B via gateway | `sak_` + HMAC → `/api/gateway/proxy/{slug}/…` | Cross-tenant keys; caller User-ID headers |
| Your backend verifies gateway proxy inbound | Verify `X-Gateway-Signature` with `ssk_` | Trusting unverified headers |
| Registered service calling notifications | `gwk_` + `X-Gateway-Signature` (`ssk_`) | Customer-facing `X-Internal-Secret` |
| AuthDeep Mail mailbox send (platform internal) | `authdeep_mail` provider / internal S2S | Exposing internal secret to customers |
| Self-hosted deploy | Compose/Helm + license | Unlicensed forever mode |

Mail **delivery** provider (tenant setting) is independent of send auth:

| Provider | When |
|----------|------|
| `smtp` | Tenant’s own SMTP (common for customer apps now) |
| `authdeep_mail` | Deliver via AuthDeep Mail |

## TOC

0. [Decision matrix](#decision-matrix-all-situations)
1. [Non-negotiable contracts](#1-non-negotiable-contracts)
2. [Bootstrap — login, CSRF, session](#2-bootstrap--login-csrf-session)
3. [Tenant settings & headless auth](#3-tenant-settings--headless-auth)
4. [Users](#4-users)
5. [Gateway services](#5-gateway-services)
6. [API keys (sak_/cak_)](#6-api-keys-sak_-cak_)
7. [Notification email — SMTP, templates, send](#7-notification-email--smtp-templates-send)
8. [Connect frontend → AuthDeep](#8-connect-frontend--authdeep)
9. [Connect backend → gateway (verify inbound)](#9-connect-backend--gateway-verify-inbound)
10. [Call another service via gateway proxy](#10-call-another-service-via-gateway-proxy)
11. [Plans / feature gates](#11-plans--feature-gates)
12. [Self-hosted](#12-self-hosted)
13. [Verify before done](#13-verify-before-done)
14. [Prompt recipes (copy-paste)](#14-prompt-recipes-copy-paste)
15. [Browser session / cookies / headless / cache](../browser-auth-integration/SKILL.md) — see **browser-auth-integration** skill

Base URL for **admin / Path A / Path C** examples: AuthDeep API origin
(`https://app.authdeep.com`, `https://app-dev.authdeep.net`).

**Path B (foreign-origin `wat_` + PoP) and Recipe G hosted signup** must use the
**tenant host**: `https://<tenant-slug>.authdeep.com`. `https://app.authdeep.com`
is the platform workspace, not your tenant. `GET /api/auth/wt/start` and
`GET /api/auth/app/start` return `tenant_host_required` on a non-tenant host.

---

## 1. Non-negotiable contracts

- **Session cookie `auth.sid` is HttpOnly.** Never put it in `localStorage`.
  Use a cookie jar (`credentials: 'include'` / curl `-c/-b`).
  For SameSite=Strict, CSRF, headless Origin allowlist, cache `no-store`, and
  same-site vs cross-domain handoff/OIDC, see the
  [browser-auth-integration](../browser-auth-integration/SKILL.md) skill.
- **CSRF on every mutation** when using a session: header `X-CSRF-Token` from
  `session.csrfToken` (or `GET /api/auth/csrf` for headless).
- **S2S uses HMAC**, never a user’s session cookie as a service credential.
- **API keys**: `sak_…` (HMAC required) and `cak_…` (HTTPS bearer-style key).
  Issued by AuthDeep only.
- **Tenant scope**: send `X-Tenant-Id: <uuid>` on gateway admin calls when the
  frontend/agent uses `tenantScoped` flows.
- **Do not invent endpoints.** If it is not in this skill or `examples/`, stop.
  Do **not** depend on PROD OpenAPI (it stays off). QA/dev OpenAPI is behind
  Zero Trust — use this skill + examples as the source of truth.

HMAC string (SAK outbound to AuthDeep):

```
METHOD\n<path+query>\n<unix_timestamp>\n<sha256hex(body)>
```

Header: `X-HMAC-Signature: t=<unix>,v1=<hex>`  
Header: `X-API-Key: sak_…`  
Clock skew > 5 minutes → reject/retry.  
Examples: `examples/backend/hmac/{python,nodejs,nextjs,java,golang}/`.

---

## 2. Bootstrap — login, CSRF, session

> Browser cookie/session details (SameSite=Strict, cache, headless Origin, cross-domain):
> [browser-auth-integration](../browser-auth-integration/SKILL.md).

### Local login (agent / script)

```http
POST /api/auth/local/login
Content-Type: application/json

{"email":"admin@tenant.example","password":"..."}
```

- No CSRF on this endpoint.
- Response `200`: `{ "session": { "userId", "tenantId", "csrfToken", "tenantRoles", "globalRole", "features", ... } }`
- Sets `Set-Cookie: auth.sid=…; HttpOnly; …`
- If `session.mfaPending: true` → complete MFA before other calls.

### Refresh session / CSRF

```http
GET /api/auth/session
Cookie: auth.sid=…
```

→ `{ "session": { …, "csrfToken": "…" } }` or `{ "session": null }`.

### Logout

```http
POST /api/auth/signout
Cookie: auth.sid=…
X-CSRF-Token: <csrfToken>
```

→ `{ "ok": true }`

### Headless login (customer’s own login UI)

Requires plan feature `white_label`, tenant `headlessAuthEnabled: true`, and
request `Origin` ∈ `headlessAllowedOrigins` (see browser-auth-integration).

```http
GET /api/auth/csrf
→ { "csrfToken": "…" }   # ephemeral if no session

POST /api/auth/headless/login
Content-Type: application/json
X-CSRF-Token: <csrfToken>

{"tenantId":"<uuid>","email":"…","password":"…","mfaCode":"optional"}
```

Examples: `examples/frontend/headless-integration/`.

**Agent rule:** keep cookie jar + `csrfToken` in memory for the whole run.
Every POST/PUT/PATCH/DELETE with the session must send `X-CSRF-Token`.

---

## 3. Tenant settings & headless auth

```http
GET /api/admin/tenants/{tenantId}/settings
Cookie: auth.sid=…
```

Important fields: `headlessAuthEnabled`, `headlessAllowedOrigins`,
`hostedAuthUiEnabled`, `hostedSigninEnabled`, `passwordLoginEnabled`,
`selfServiceSignupEnabled`, `notificationsEmail`, …

```http
PUT /api/admin/tenants/{tenantId}/settings
Cookie: auth.sid=…
X-CSRF-Token: <csrf>
Content-Type: application/json

{
  "headlessAuthEnabled": true,
  "headlessAllowedOrigins": ["https://app.customer.com"],
  "passwordLoginEnabled": true,
  "notificationsEmail": true
}
```

Branding (hosted login look):

| Method | Path |
|--------|------|
| GET/PUT | `/api/admin/tenants/{tenantId}/branding` |
| POST | `/api/admin/tenants/{tenantId}/branding/logo` (multipart) |
| GET | `/api/branding` (public, no auth) |

---

## 4. Users

```http
GET /api/admin/users?filter=&offset=0&limit=50&includeContext=true
Cookie: auth.sid=…
```

Optional (global_admin): `&tenantId=<uuid>`.

Response: `{ "users": [ { "id","email","displayName","role","tenantId","active","status",… } ], "total": N }`

Requires `tenant_admin` | `global_admin` | `super_admin`.

---

## 5. Gateway services

Register your backend so the gateway can proxy to it and issue `gwk_` / `ssk_`.

```http
GET /api/gateway/services
Cookie: auth.sid=…
X-Tenant-Id: <tenantId>
```

```http
POST /api/gateway/services
Cookie: auth.sid=…
X-CSRF-Token: <csrf>
X-Tenant-Id: <tenantId>
Content-Type: application/json

{
  "slug": "orders-api",
  "name": "Orders API",
  "backendUrl": "https://orders.internal.example/api",
  "openApiPath": "/openapi.json",
  "healthPath": "/health"
}
```

**201 — secrets shown once:**

```json
{
  "service": {
    "id": "…",
    "slug": "orders-api",
    "gatewayApiKey": "gwk_…",
    "serviceSecretKey": "ssk_…"
  }
}
```

Store `ssk_` in the backend secrets manager. `gwk_` identifies the service on
inbound gateway→backend requests.

Also: `GET/PUT/DELETE /api/gateway/services/{serviceId}`,
`GET /api/gateway/services/{serviceId}/integration`.

---

## 6. API keys (sak_/cak_)

There is **no** separate “notification key” prefix. Use `sak_` (recommended for
servers) or `cak_`.

### Permission model

Each permission row is **XOR**:

| Field | Use |
|-------|-----|
| `serviceId` + `httpMethod` | Proxy access to that registered service |
| `capability: "notifications_email"` + `httpMethod` | Platform route `/api/gateway/notifications/*` only |

### Create SAK for notifications (no service required) — preferred

Requires backend ≥ **0.314.0** (migration V100).

```http
POST /api/gateway/api-keys/service
Cookie: auth.sid=…
X-CSRF-Token: <csrf>
X-Tenant-Id: <tenantId>
Content-Type: application/json

{
  "label": "notification-sender",
  "hmacAlgorithm": "sha256",
  "replayWindowSecs": 300,
  "rateLimitRequests": 100,
  "rateLimitWindowSecs": 60,
  "permissions": [
    { "capability": "notifications_email", "httpMethod": "POST" }
  ]
}
```

**201 — copy once:**

```json
{
  "id": "…",
  "key": "sak_…",
  "hmacSecret": "…",
  "note": "Store key and hmacSecret securely — they will NOT be shown again"
}
```

### Create SAK scoped to a gateway service

```json
"permissions": [
  { "serviceId": "<service-uuid>", "httpMethod": "*" }
]
```

### Create CAK

```http
POST /api/gateway/api-keys/client
…
{ "label": "partner", "permissions": [ … ], "ipWhitelist": [], "allowedOrigins": [] }
```

CAK: send `X-API-Key: cak_…` only (no HMAC). Prefer SAK for servers.

### List / rotate / permissions

| Method | Path |
|--------|------|
| GET | `/api/gateway/api-keys/service` · `/client` |
| PUT | `/api/gateway/api-keys/service/{id}/permissions` |
| POST | `/api/gateway/api-keys/service/{id}/rotate` |

### UI note (admin console)

Frontend **≥ 0.104.0**: Create Service Key → **Access scope** →
**Platform APIs → Notification email**.

Older UI still shows **Service access (required)** only. Use the **API** above,
or pick any existing service + **POST** (back-compat: service POST still
authorises notification send). Deploy FE `0.104.0` to get the Platform option.

---

## 7. Notification email — SMTP, templates, send

**Law (AuthDeep platform):** signup / sign-in / password-reset / MFA email OTP /
welcome **always** deliver from `noreply@authdeep.com` (system sender). Tenant
Notification Email SMTP / AuthDeep Mail does **not** control those paths —
only `POST /api/gateway/notifications/email` (and API/app mail). Per-tenant
**templates** still brand auth subject/body. Settings + templates are always
tenant-scoped (`X-Tenant-Id` / effective tenant). AuthDeep SaaS uses the
`default` tenant for platform admin; that must not override system auth From.

AuthDeep can deliver **your own transactional** messages through tenant
notification config. Auth emails use platform delivery + optional templates.

### 7a. Enable + configure provider

```http
GET /api/gateway/notifications/settings
Cookie: auth.sid=…
X-Tenant-Id: <tenantId>
```

```http
PUT /api/gateway/notifications/settings
Cookie: auth.sid=…
X-CSRF-Token: <csrf>
X-Tenant-Id: <tenantId>
Content-Type: application/json

{
  "notifications_email": true,
  "provider": "smtp",
  "smtp_host": "smtp.example.com",
  "smtp_port": 587,
  "smtp_username": "user",
  "smtp_password": "secret",
  "smtp_from": "noreply@example.com",
  "email_rate_limit": 100
}
```

`provider`:

| Value | Meaning |
|-------|---------|
| `smtp` | Tenant’s own SMTP (signup/signin/OTP via this SMTP) |
| `authdeep_mail` | Route through AuthDeep Mail (`mail_from` mailbox) |

Omit `smtp_password` to keep existing; `""` clears.

Also enable tenant flag via settings if needed: `"notificationsEmail": true`
on `/api/admin/tenants/{id}/settings`.

### 7b. Templates

```http
GET /api/gateway/notifications/templates
Cookie: auth.sid=…
X-Tenant-Id: <tenantId>

PUT /api/gateway/notifications/templates/welcome
Cookie: auth.sid=…
X-CSRF-Token: <csrf>
X-Tenant-Id: <tenantId>
Content-Type: application/json

{
  "subject": "Welcome {{first_name}}",
  "html_body": "<p>Hi {{first_name}}</p>",
  "text_body": "Hi {{first_name}}"
}

DELETE /api/gateway/notifications/templates/welcome
Cookie: auth.sid=…
X-CSRF-Token: <csrf>
X-Tenant-Id: <tenantId>
```

### 7c. Send (your application backend — no browser)

```http
POST /api/gateway/notifications/email
Content-Type: application/json
X-API-Key: sak_…
X-HMAC-Signature: t=<unix>,v1=<hex>

{
  "to": "user@example.com",
  "subject": "Your code",
  "html_body": "<p>Code {{code}}</p>",
  "text_body": "Code {{code}}",
  "variables": { "code": "482915" }
}
```

Or template:

```json
{ "to": "…", "template": "welcome", "variables": { "first_name": "Ada" } }
```

**Success:** `202` `{ "accepted": true }`

**Auth alternatives for send:**

1. `sak_` + HMAC (preferred)
2. `cak_` + `X-API-Key` only
3. `X-Gateway-Key: gwk_…` + `X-Gateway-Signature` (signed with service `ssk_`)
4. Admin session + CSRF

Runnable: `examples/mail/{nodejs,python,go}/send_notification.*`

### 7d. Signup / signin emails from YOUR app

Two different paths — do not confuse them:

| Goal | How |
|------|-----|
| AuthDeep-hosted auth emails (OTP, magic link, password reset) | Configure §7a SMTP/`authdeep_mail`. AuthDeep sends them itself. |
| Emails YOUR backend sends after signup/signin in **your** product | Create SAK with `notifications_email` (§6) and call §7c from your backend. |

Do **not** use mail-backend `X-Internal-Secret` / `POST /v1/transactional/send`
from customer apps — that is AuthDeep-internal only.

---

## 8. Connect frontend → AuthDeep

**Same-site (Path A):** SPA on AuthDeep / same registrable domain.

1. `POST /api/auth/local/login` or headless login with `credentials: 'include'`.
2. `GET /api/auth/session` → store `csrfToken` in memory.
3. Every mutation: `X-CSRF-Token` + cookies.
4. Call `/api/gateway/proxy/{slug}/…` with cookies. Gateway injects User-ID + Email + Roles.

**Foreign origin (Path B):** cookies will not attach. Do **not** use `cak_`/`sak_` for humans.

Set `AUTHDEEP_BASE_URL=https://<tenant-slug>.authdeep.com` (never `https://app.authdeep.com`).

1. Browser → `GET https://<tenant-slug>.authdeep.com/api/auth/wt/start?redirect_uri=<exact allowlisted>&state=…`
2. No `auth.sid` → hosted login with `next=/api/auth/wt/start?…`. After login / MFA / signup the SPA **resumes** that `next`. Resumable `next` paths (relative, leading `/`, no `//`):
   - `/oauth2/authorize`
   - `/api/tenants/{slug}/oidc/authorize`
   - `/api/auth/mail-app/start`
   - `/api/auth/cli/start`
   - `/api/auth/app/start`
   - `/api/auth/wt/start`
3. `wt/start` validates `redirect_uri` against **that tenant’s** allowlist → 302 to `redirect_uri?wst=…&state=…`
4. `POST /api/auth/wt/exchange` `{ wst, origin, popJwk }` → `wat_` + PoP (D1-B memory, or D1-C Worker — `examples/wt-d1c-worker/`).
5. Every gateway call: `Authorization: Bearer wat_…` + PoP headers. No `/wt/refresh`. Reload → `wt/start` again.

`wt/start` allowlists the **exact** `allowedRedirectUris` URL. Credentialed CORS for keepalive/proxy from that app also includes `webAllowedOrigins`, tenant CORS lists, and the **origin** (scheme+host) of each `allowedRedirectUris` entry. Register the callback URL and the browser origin.

Do not guess upstream identity headers. Copy the tables in [§9](#9-connect-backend--gateway-verify-inbound) (`X-AuthDeep-User-ID`, `X-AuthDeep-User-Email`, `X-AuthDeep-User-Roles`, `X-AuthDeep-Auth-Type`, `X-AuthDeep-Tenant-ID`, plus gateway HMAC headers). Path C (`sak_`/`cak_`) never gets user identity headers.

Examples: `examples/frontend/{nextjs-integration,react-integration,headless-integration}/` (Path A / headless). Path B Worker: `examples/wt-d1c-worker/`.

Never embed `sak_` / `ssk_` in FE. `cak_` is Path C (machine) — no user identity headers.

---

## 9. Connect backend → gateway (verify inbound)

When a client hits:

```
/api/gateway/proxy/{slug}/…  →  your backendUrl + …
```

### Always present

| Header | Meaning |
|--------|---------|
| `X-Gateway-Key` | `gwk_…` |
| `X-Gateway-Signature` | `t=…,v1=…` HMAC with **ssk_** |
| `X-Gateway-Timestamp` | unix seconds (prefer `t=` inside Signature) |
| `X-Gateway-Request-Id` | correlation id (always set) |
| `X-AuthDeep-Tenant-ID` | **authoritative** tenant UUID |
| `X-Forwarded-Tenant-Id` | legacy alias of tenant (same value) |
| `X-AuthDeep-Client-IP` | visitor IP resolved by the gateway |
| `X-Real-IP` | same visitor IP |
| `X-Forwarded-For` | single visitor IP (not a chain) |

The gateway **never** sends `CF-Connecting-IP` or `True-Client-IP` to a
registered origin. Those are Cloudflare-owned hop headers. Forging them against
a Cloudflare-fronted origin (Render `*.onrender.com`, orange-cloud SaaS) is
Cloudflare **Error 1000**. Visitor IP uses `X-AuthDeep-Client-IP` / `X-Real-IP` /
`X-Forwarded-For` only.

If the origin returns a Cloudflare 1000 page (`text/html` or `text/plain`,
`error code: 1000` / `DNS points to prohibited IP`), the gateway answers
**`502 {"error":"upstream_unreachable"}`** instead of copying that `403` HTML.
Treat that as infrastructure, not a credential failure — do not destroy a
fresh session on a proxy 403 that is not JSON.

Caller-supplied `X-AuthDeep-*` / `X-Gateway-*` / `X-Forwarded-*` trust headers are
**stripped** then re-injected from validated auth. HMAC signs method + path +
timestamp + body hash only — **identity headers are not in the signature**.

WebSocket hops use the **same** identity rules: Cookie / Authorization / WAT /
API key / PoP / HMAC / nonce are stripped; gateway injects identity + HMAC.

### Path table (A / B / C)

| Path | Client proof | Upstream identity |
|------|----------------|-------------------|
| **A** | `auth.sid` + CSRF on mutations | User-ID, Email, Roles, Tenant-ID |
| **B D1-B** | `wat_` (memory) + PoP every method | Same human inject |
| **B D1-C** | App-host HttpOnly cookie via Worker | Same human inject |
| **C** | `sak_` / `cak_` + HMAC | Tenant + key meta **only** — never User-ID/Email/Roles |

### Human callers (`auth.sid` cookie **or** cross-domain `wat_` + PoP)

| Header | Meaning |
|--------|---------|
| `X-AuthDeep-User-ID` | authenticated user |
| `X-AuthDeep-User-Email` | email |
| `X-AuthDeep-User-Roles` | comma-separated `tenantRoles` |
| `X-AuthDeep-Auth-Type` | `session` (cookie) or `web_token` (`wat_`) |
| `X-Forwarded-User-Id` | legacy alias of User-ID |

### API-key callers (`sak_` / `cak_`)

| Header | Meaning |
|--------|---------|
| `X-AuthDeep-API-Key-ID` | key id |
| `X-AuthDeep-API-Key-Type` | `service` (`sak_`) or `client` (`cak_`) |
| `X-AuthDeep-Auth-Type` | `api_key` |

No end-user User-ID / Email / Roles. Tenant + key meta only. Do **not** assert
user identity via headers on this path.

### Cross-domain browser (foreign origin) — `/api/auth/wt/*`

There is **no** `/api/auth/wt/refresh`. Keepalive is not a refresh token.

**Host:** `https://<tenant-slug>.authdeep.com` only for minting. Unauthenticated
`GET /api/auth/wt/start` on a non-tenant host still returns `400 tenant_host_required`.
If the request carries a valid `auth.sid` (for example after magic-link verify
used to land on `app.authdeep.com`), `wt/start` **302s** to the same path on
`https://{primaryTenant.subdomain}.authdeep.com` instead of 400.

Magic-link emails use the **platform host** (`APP_BASE_URL`) until the tenant
enables **Magic link on tenant host** in Tenant Settings. Enabling appends that
workspace origin (`https://{slug}.{base}` from CookieDomain / CFBaseDomain /
APP_BASE_URL — never a `*.authdeep.com` wildcard) to `magic_link_allowed_origins`.
`POST /api/auth/local/magic-link` on a tenant host without that flag returns
`403 magic_link_hosted_disabled`. Cold Path B must complete magic-link + MFA on
the tenant host so `next=/api/auth/wt/start` stays same-origin.

### Passkeys on the tenant host (and custom domain)

`passkeyLoginEnabled` defaults **false**. Enabling it appends the tenant hosted
origin (and a verified custom domain, if any) to an **explicit** origin list.
`RPOrigins` is never a DNS wildcard. Platform origin is always
`APP_BASE_URL` (`https://app.authdeep.com` / `https://app-qa.authdeep.net` /
`https://app-dev.authdeep.net`).

| Ceremony host | RP ID | How it gets allowed |
|---------------|-------|---------------------|
| Platform `APP_BASE_URL` | eTLD+1 of that URL | Always (config) |
| `{slug}.authdeep.com` / `{slug}.authdeep.net` | same eTLD+1 | Tenant Settings → Passkey login on tenant host |
| Customer frontend (Worker, etc.) | **full hostname** (not `workers.dev`) | Security Rules → exact origin in headless/web list **and** passkey enabled |
| Verified custom domain | that hostname | Enable passkey (adds `https://{custom}`) |

Passkeys enrolled under the old RP ID `app.authdeep.com` **do not appear** after
RP ID becomes `authdeep.com` — users re-enroll once.

`GET /api/branding` returns `passkeyLoginEnabled` (default `false`). Discoverable
login returns `403 passkey_login_disabled` when off, or `403 passkey_origin_not_allowed`
when the request origin is not on the list. Headless passkey cannot share
AuthDeep RP ID; credentials do not transfer across RP IDs.

Tenant admins: Tenant Settings (passkey + magic-link-on-tenant-host) and
Security Rules (exact customer-frontend origins). No wildcards.

1. `GET /api/auth/wt/start?redirect_uri=<exact allowlisted>` (cookie on AuthDeep). Unauthenticated requests 302 to hosted login with `next=/api/auth/wt/start?…` — that path is a resumable `next` (allowlist: `/api/auth/{mail-app,cli,app,wt}/start`, `/oauth2/authorize`, `/api/tenants/{slug}/oidc/authorize`).
2. Redirect returns `?wst=wst_…` (60s single-use, origin-bound)
3. `POST /api/auth/wt/exchange` with `{ wst, origin, popJwk }` — `popJwk` is the
   **public** EC P-256 JWK only (`kty/crv/x/y`). Private `d` stays in memory (D1-B)
   or in the Worker (D1-C). Response includes `user` (`userId`, `email`, `name`,
   `tenantId`, `tenantRoles`) as a **stable** display contract; authorization still
   comes only from gateway-injected `X-AuthDeep-*` headers on proxy calls.
4. Call gateway with `Authorization: Bearer wat_…` + `X-PoP-Signature` /
   `X-PoP-Timestamp` + `Origin` on **every** method. Path B works on
   `accessMode: private` / `isPublic: false` services (same as a cookie session).
   `requireAuth: false` still validates a presented `wat_` — it does not ignore it.
5. **TTL sliding (same rules both ways):**
   - `wat_` **starts at 60s** from iat
   - Successful **gateway proxy** hop slides `wat_` Redis TTL (+60s)
   - `POST /api/auth/wt/keepalive` also slides (+60s)
   - Empty body or `{}`; require allowlisted `Origin`; response `{ expiresAt }`
     (also `expiresIn`, `capAt`)
   - Absolute hard cap **120s from iat** — platform-wide, not per-tenant
     configurable. Then `401 token_cap_exceeded` → run `wt/start` again
   - Keepalive does not mint a new `wat_`, rotate PoP, or return a session id
   - Path A / D1-C cookie sessions do **not** need this endpoint
6. Tab reload (D1-B): PoP key is memory-only → run `wt/start` again

D1-B idle SPA interval (stop at cap):

```javascript
const iv = setInterval(async () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const r = await fetch(AUTHDEEP + '/api/auth/wt/keepalive', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + wat,
      Origin: location.origin,
      'Content-Type': 'application/json',
      'X-PoP-Timestamp': ts,
      'X-PoP-Signature': await signPoP('POST', '/api/auth/wt/keepalive', ts),
    },
    body: '{}',
  });
  if (r.status === 401) { clearInterval(iv); await wtStart(); }
}, 45_000);
```

PoP (ES256, payload `METHOD:path:TIMESTAMP`):

- `path` is the **full request path as received by AuthDeep**, e.g.
  `/api/gateway/proxy/blog-api/api/users/me`. It is **not** the post-`stripPrefix`
  upstream path. Query string is **not** included. Sign `r.URL.Path` with no
  trailing-slash normalisation beyond what the client actually requested.
- Signature: ECDSA P-256 over SHA-256 of that UTF-8 string, **DER** encoded,
  then **base64url without padding** (standard base64 of the same DER is also
  accepted). WebCrypto raw `r‖s` (P1363) is not accepted. Copy `signPop` /
  `rawSigToDerBase64Url` from `examples/wt-d1c-worker/worker.mjs`.
- `Authorization: Bearer wat_…` is the correct presentation on `/api/gateway/proxy/*`
  (optional equivalent: `X-AuthDeep-Web-Token: wat_…`).
- Distinct errors when a `wat_` is presented but rejected (no longer collapsed
  into `401 authentication required`):

| HTTP | `error` | Meaning |
|------|---------|---------|
| 401 | `authentication required` | No cookie, no API key, and no `wat_` header |
| 401 | `invalid_or_expired_token` | `wat_` unknown or Redis TTL expired |
| 401 | `token_cap_exceeded` | Absolute 120s cap |
| 403 | `origin_required` / `origin_mismatch` | `Origin` missing or not the exchange origin |
| 403 | `pop_required` / `pop_failed` | Missing PoP headers or signature/path/timestamp mismatch |

`401 authentication required` with a `wat_` on the wire was a PoP/origin miss
being swallowed; it now returns one of the 403/401 codes above.

**Never** send `X-Session-Id` (removed ISSUE-321). Pure static apps use `wat_`+PoP
in memory (**D1-B**). Apps with a same-origin Worker (**D1-C**): store `wat_`
server-side + HttpOnly app cookie (see `examples/wt-d1c-worker/`).

**Path C (`sak_` / `cak_`):** upstream never gets User-ID / Email / Roles — even
if the caller sends them. Tenant + key meta only.

Signed payload for inbound verification (path only, trailing slash stripped):

```
METHOD\npath\ntimestamp\nhex(SHA256(body))
```

Reject invalid signatures. Prefer `X-AuthDeep-Tenant-ID` over client `X-Tenant-Id`.

---

## 10. Call another service via gateway proxy

**Correct proxy path (code):**

```
/api/gateway/proxy/{slug}/{upstreamPath}
```

Example:

```http
POST /api/gateway/proxy/orders-api/v1/orders
Content-Type: application/json
X-API-Key: sak_…
X-HMAC-Signature: t=<unix>,v1=<hex>

{"sku":"…"}
```

HMAC is over `RequestURI` (path **including** query string).

Service A → Service B: both registered under the same tenant; caller holds a
`sak_` with permission on B’s `serviceId` (or `*`).

---

## 11. Plans / feature gates

- Feature not on plan → `403`/`402`; do not invent client-side unlocks.
- Check entitlements from `session.features` or admin tenant APIs.
- Gateway routes require plan feature `api_gateway`.
- Headless login requires `white_label`.

---

## 12. Self-hosted

```bash
git clone https://git.authdeep.net/authdeep/authdeep-public
cd authdeep-public/examples/self-hosted
cp .env.example .env   # real secrets only
docker compose up -d
```

Helm: `helm/authdeep/`. Valid license required.

---

## 13. Verify before done

1. Real HTTP capture against a live AuthDeep env (DEV/QA).
2. CSRF missing → fail; wrong tenant → fail.
3. No secrets in git, logs, or FE bundles.
4. Diff against the matching `examples/` folder.

---

## 14. Prompt recipes (copy-paste)

Use the [decision matrix](#decision-matrix-all-situations). Recipes below are
**alternatives**, not a single mandatory path.

### A. App backend → send via tenant SMTP (`sak_` runtime)

```
Situation: customer application sends signup/signin/OTP/custom mail.
Runtime auth: sak_ + HMAC only (no end-user password in the app).

One-time setup (admin UI OR admin session API — sections 2+7):
- PUT notifications/settings: notifications_email=true, provider=smtp,
  smtp_host, smtp_port, smtp_username, smtp_password, smtp_from
- Create SAK with permissions:
  [{ "capability":"notifications_email", "httpMethod":"POST" }]
  (FE >= 0.104.0: Platform APIs → Notification email)
  Older FE: any gateway service + POST
- Store in app secrets:
  AUTHDEEP_GATEWAY_URL, AUTHDEEP_SERVICE_KEY=sak_…, AUTHDEEP_SIGNING_SECRET

Runtime send:
  POST /api/gateway/notifications/email
  X-API-Key + X-HMAC-Signature
  Body: to + subject/bodies OR template + variables
  Expect 202 { "accepted": true }
  Delivery uses the configured SMTP.

Examples: examples/mail/*/send_notification.*; examples/backend/hmac/
Forbidden in app: user password login, X-Internal-Secret, sak_ in frontend
```

### B. Admin UI — SMTP + Platform API key (human QA)

```
1. Notification Email → Provider SMTP → fill host/port/user/password/from → Save
2. API Keys → Create service key → Platform APIs → Notification email → POST
3. Copy sak_ + HMAC secret into app env
4. App uses recipe A
FE must be >= 0.104.0 for Platform APIs row (QA/PROD tags deployed).
```

### C. Admin session API — provision SMTP + SAK (automation / agents)

```
Situation: CI/onboarding agent with a short-lived admin session (not app runtime).
1. POST /api/auth/local/login (or headless) → cookie + csrfToken  [admin only]
2. PUT /api/gateway/notifications/settings (SMTP fields) + CSRF + X-Tenant-Id
3. POST /api/gateway/api-keys/service with capability notifications_email
4. Hand sak_/hmac to the app secret store; discard admin session
5. App forever uses recipe A
```

### D. Gateway service + proxy + inbound verify

```
1. Admin: POST /api/gateway/services → save gwk_ + ssk_
2. Backend: verify X-Gateway-Signature with ssk_ (section 9)
3. Admin: mint sak_ with { serviceId, httpMethod:"*" }
4. Callers: POST /api/gateway/proxy/{slug}/… with sak_ + HMAC
```

### E. Frontend session / headless

```
Hosted login: examples/frontend/{nextjs,react}-integration/
Headless: enable headlessAuthEnabled + origins; GET /api/auth/csrf;
  POST /api/auth/headless/login; keep csrf in memory; cookie HttpOnly
Mail from the SPA’s backend still uses recipe A — never sak_ in the browser.
```

### F. CAK / gateway-signature notification send

```
CAK: X-API-Key: cak_… (no HMAC); lock origins/IPs; same POST body as A
Registered service: X-Gateway-Key: gwk_… + X-Gateway-Signature with ssk_
```

### G. Public self-service signup + login for YOUR customer-facing app

Use this when **the public** (your blog readers, your SaaS end users) create
accounts and sign in on your site. Do NOT create an OIDC client for anonymous
self-registration — OIDC authorize requires an existing tenant member, so new
users get `access_denied` until they join via hosted signup.

**Requires** AuthDeep build that includes host-bind fix (bug-0421) and tenant app
handoff (feature-0523). Until then, use admin invite
`POST /api/admin/tenants/{tenantId}/users/invite` only.

```
One-time tenant setup (admin UI → Tenant Settings → Auth surfaces & origins):
- hostedAuthUiEnabled: true
- selfServiceSignupEnabled: true
- Web app origins: your app origin (https://blog.example.com)
- Allowed redirect URIs: your exact callback
  (https://blog.example.com/auth/callback) — used by /api/auth/app/start

Runtime (hosted redirect — no OIDC client):
1. Send new users to:
   https://<tenant>.authdeep.com/auth/signup?next=/api/auth/app/start?redirect_uri=<urlencoded exact allowedRedirectUri>&state=<opaque>
   Returning users:
   https://<tenant>.authdeep.com/auth/login?next=/api/auth/app/start?redirect_uri=<urlencoded exact allowedRedirectUri>&state=<opaque>

   IMPORTANT:
   - `next` MUST be a relative path starting with /api/auth/app/start
   - Absolute https:// URLs in `next` are rejected (open-redirect protection)
   - `redirect_uri` query value MUST exact-match a tenant allowedRedirectUri

2. Hosted UI joins the user to THAT tenant (selfServiceSignupEnabled), then
   resumes `next` → AuthDeep validates redirect_uri → 302 to your callback
   with ?code=…&state=…

3. Your app backend exchanges the code for identity (not an AuthDeep session):
   POST https://<tenant>.authdeep.com/api/auth/app/exchange
   { "code": "…" }
   → { userId, email, name, tenantId, tenantRoles, globalRole }
   Code is single-use (~2 minutes). Build YOUR app session from that identity.
   Never expect auth.sid on your domain (SameSite=Strict on .authdeep.com).

Rules:
- NEVER create a confidential OIDC client for anonymous public signup.
- OIDC (AuthDeep as IdP) is for already-provisioned members / Access.
- selfServiceSignupEnabled must be true or hosted join-signup 403s.
- Headless login is a separate Scale/Enterprise surface; do not enable it as a
  workaround for Recipe G.
```
