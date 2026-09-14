# AuthDeep gateway integration

How Harbor's API is wired up to sit behind an AuthDeep API gateway, and how
to operate it going forward. Written as the "what we did and why" record —
read it before touching gateway auth again.

## What this integration is

Harbor's API (`apps/api`) is registered with AuthDeep as gateway service
**`harbor-api`**. External callers hit AuthDeep at:

```
<your-authdeep-base-url>/api/gateway/proxy/harbor-api/<harbor-path>
```

e.g. `.../api/gateway/proxy/harbor-api/products`. AuthDeep authenticates the
caller (their session, or a `sak_`/`cak_` API key), then forwards the request
to Harbor's registered `backendUrl` (the Render URL,
`https://harbor-6jd6.onrender.com`), signing the hop with the service's
`ssk_` secret and injecting trusted identity headers.

This is the **"Connect backend → gateway (verify inbound)"** pattern from the
gateway-integration skill's decision matrix: Harbor's job is to verify
`X-Gateway-Signature` on every inbound request and reject anything that isn't
genuinely from AuthDeep. Harbor does not call AuthDeep itself — it's a
proxied backend, not a client.

## What was already done (outside this repo)

Someone registered the service in AuthDeep admin
(`POST /api/gateway/services`), which is how these two values were minted:

| Value | What it is | Given to this integration |
|---|---|---|
| `gwk_7d1f8763...` | Gateway identity key — identifies inbound requests as coming from *this* registered service | Yes, in chat |
| `ssk_...` | Service secret key — signs every gateway→backend hop | Not yet — see below |

## Where the keys go — do not paste the `ssk_` into this chat

The gateway key and secret are config, not code. They must never be
committed or hardcoded. Two places only:

1. **Local `.env`** (already gitignored — see [.gitignore](.gitignore)):
   ```
   AUTHDEEP_GATEWAY_KEY=gwk_7d1f876385a4e9e44aa7b1a817428c6fb6703b693a388f5120ea4c5efe000442
   AUTHDEEP_SERVICE_SECRET=ssk_<paste the real value here yourself>
   ```
2. **Render dashboard** → harbor-api service → **Environment** → add both as
   environment variables (mark `AUTHDEEP_SERVICE_SECRET` as a secret if
   Render's UI offers that). Do **not** put either in the `Dockerfile` or any
   committed file.

Placeholders for both were added to [.env.example](.env.example) so the shape
is documented without real values ever touching git.

If `AUTHDEEP_SERVICE_SECRET` (or `AUTHDEEP_GATEWAY_KEY`) is unset, gateway
requests get `500 { "error": "gateway not configured" }` — Harbor refuses to
half-verify.

## What changed in the code

| File | Change |
|---|---|
| [apps/api/src/auth.ts](apps/api/src/auth.ts) | `requireApiKey` now branches: if `X-Gateway-Key` is present, verify the AuthDeep gateway signature (`verifyGatewaySignature`); otherwise fall back to the existing `X-Harbor-Key` check. |
| [apps/api/src/index.ts](apps/api/src/index.ts) | Added a custom `application/json` content-type parser that captures the exact raw request body (`request.rawBody`) alongside the parsed JSON — needed because the HMAC signs the raw bytes, not a re-serialized object. |
| [apps/api/src/products.ts](apps/api/src/products.ts) | Auth hook moved from `onRequest` to `preHandler`, since `rawBody`/`body` aren't populated until the body has been parsed. |

Both auth paths stay live on purpose: the worker
([apps/worker/src/harborClient.ts](apps/worker/src/harborClient.ts)) calls
Harbor directly with `X-Harbor-Key` and never goes through AuthDeep, so that
path can't be removed.

### How the signature is verified

Per the skill's inbound-verification contract (§9):

```
signed string = METHOD "\n" path "\n" unix_timestamp "\n" sha256hex(raw_body)
```

- `path` is the request path only (no query string), trailing slash stripped
  — this is the path Harbor receives, i.e. already stripped of the
  `/api/gateway/proxy/harbor-api` prefix by the gateway.
- `raw_body` is `""` for bodyless requests (its sha256 is the well-known
  `e3b0c442...` empty-string hash).
- Expected header: `X-Gateway-Signature: t=<unix_timestamp>,v1=<hex hmac>`,
  HMAC-SHA256 keyed with `AUTHDEEP_SERVICE_SECRET`.
- `X-Gateway-Key` must equal `AUTHDEEP_GATEWAY_KEY`.
- Requests older/newer than 300s (clock skew) are rejected.
- Comparison uses `crypto.timingSafeEqual` (no early-exit string compare).

On success, the injected identity headers are trusted and attached to
`request.gateway`:

```ts
{ tenantId, apiKeyId, apiKeyType, userId, userEmail, userRoles, authType, requestId }
```

(from `X-AuthDeep-Tenant-ID`, `X-AuthDeep-API-Key-ID`, `X-AuthDeep-API-Key-Type`,
`X-AuthDeep-User-ID`, `X-AuthDeep-User-Email`, `X-AuthDeep-User-Roles`,
`X-AuthDeep-Auth-Type`, `X-Gateway-Request-Id`). Nothing currently reads
`request.gateway` — it's there for whoever adds tenant-aware logic or
audit logging next, so route handlers don't have to re-parse headers.

## Verified locally

Ran the API locally with test credentials
(`AUTHDEEP_GATEWAY_KEY=gwk_test`, `AUTHDEEP_SERVICE_SECRET=ssk_testsecret`)
and confirmed all four cases:

| Request | Result |
|---|---|
| Correctly signed `GET /products` | `200` |
| Same request, tampered signature | `401` |
| No auth headers at all | `401` |
| Legacy `X-Harbor-Key` (worker path) | `200` — unaffected |
| Correctly signed `POST /products/WIDGET-1/adjust` with a JSON body | `200`, body hash matched |

Reproduce with `node -e` to build the HMAC (see git history of this file's
commit, or the gateway-integration skill's §1/§9) — or once you have real
AuthDeep credentials, trigger a real call through the proxy and confirm it
reaches Harbor with a `200`.

## Still to do (in AuthDeep, not this repo)

1. **Confirm the registered service config** matches reality: `backendUrl =
   https://harbor-6jd6.onrender.com`, `healthPath = /health`. If the service
   was registered before the Render deploy existed, double-check this.
2. **Set `AUTHDEEP_GATEWAY_KEY` and `AUTHDEEP_SERVICE_SECRET`** in Render's
   dashboard (see above) and redeploy — without them every gateway-proxied
   request will 500.
3. **Mint a `sak_` for callers** (recipe D, step 3):
   ```
   POST /api/gateway/api-keys/service
   { "permissions": [{ "serviceId": "<harbor-api service id>", "httpMethod": "*" }] }
   ```
   Hand the resulting `sak_` + HMAC secret to whatever service will call
   Harbor through the gateway.
4. **Callers use**:
   ```
   POST <authdeep-base>/api/gateway/proxy/harbor-api/products/WIDGET-1/adjust
   X-API-Key: sak_...
   X-HMAC-Signature: t=...,v1=...
   ```
   signed per the skill's §1 outbound HMAC recipe — not the same signature
   as the inbound one Harbor verifies; the gateway re-signs on the way in.

## Troubleshooting a `401` from the gateway path

- **Wrong/missing env var** — `AUTHDEEP_GATEWAY_KEY`/`AUTHDEEP_SERVICE_SECRET`
  not set on Render, or don't match what AuthDeep issued for `harbor-api`.
- **Clock skew** — Render host clock or AuthDeep's clock more than 5 minutes
  off; usually transient, retry.
- **Path mismatch** — signature computed over a path AuthDeep didn't
  actually forward (e.g. including the `/api/gateway/proxy/harbor-api`
  prefix, or a trailing slash Harbor stripped). Check `request.url` in
  Harbor's logs against what was signed.
- **Body mismatch** — anything that touches the body between AuthDeep
  signing it and Harbor receiving it (a proxy, a body-parsing library that
  reformats JSON) breaks the hash. Harbor hashes the exact raw bytes it
  received.
