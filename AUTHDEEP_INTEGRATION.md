# AuthDeep gateway integration

How Harbor is wired up to AuthDeep, and how to operate it going forward.
Written as the "what we did and why" record — read it before touching
gateway auth again. This is **Phase 2** of [PLAN.md](PLAN.md) (AuthDeep Path
C), applied in full: `X-Harbor-Key` is gone, the worker no longer writes
outbox files.

## What this integration is

Two independent pieces, both **Path C** (`sak_`/`cak_` + HMAC — no human
identity ever reaches Harbor):

1. **API verifies inbound gateway requests.** Harbor's API (`apps/api`) is
   registered with AuthDeep as gateway service **`harbor-api`**. External
   callers hit AuthDeep at
   `<authdeep-base>/api/gateway/proxy/harbor-api/<path>`; AuthDeep
   authenticates the caller, then forwards to Harbor's `backendUrl` (the
   Render deployment), signing the hop with the service's `ssk_`. Harbor's
   job is to verify that signature and reject anything not genuinely from
   AuthDeep — the skill's **"Connect backend → gateway (verify inbound)"**
   pattern.
2. **Worker calls out through AuthDeep, both for data and mail.** The digest
   worker no longer talks to Harbor's API directly, and no longer writes
   `.html` files to an outbox. It reads products via the same
   `/api/gateway/proxy/harbor-api/...` route (as a `sak_`-authenticated
   caller) and sends the digest via `POST /api/gateway/notifications/email`
   — the skill's **"App backend → send via tenant SMTP"** recipe. One `sak_`
   covers both, since PLAN.md's service key is minted with permissions for
   both the `harbor-api` service and the `notifications_email` capability.

## What changed in the code

### API (`apps/api`)

| File | Change |
|---|---|
| [apps/api/src/auth.ts](apps/api/src/auth.ts) | `requireApiKey` (`X-Harbor-Key` check, with a gateway-signature fallback) replaced entirely by `requireGatewaySignature`. No fallback, no legacy key — gateway signature verification is the only auth path. Logs one line per authenticated request (`auth_type`, `api_key_type`, `user_id_present`) and calls out a warning if `X-AuthDeep-User-ID` is ever present, since Path C must never carry one. |
| [apps/api/src/products.ts](apps/api/src/products.ts) | Hook updated to `requireGatewaySignature`. |
| [apps/api/src/index.ts](apps/api/src/index.ts) | Unchanged from the earlier gateway work — still captures `request.rawBody` (the HMAC signs raw bytes, not re-serialized JSON). |

`HARBOR_API_KEY` no longer exists anywhere in the codebase.

### Worker (`apps/worker`)

| File | Change |
|---|---|
| [apps/worker/src/harborClient.ts](apps/worker/src/harborClient.ts) | Rewritten. No more direct `fetch(HARBOR_API_URL, { headers: { X-Harbor-Key } })`. Now exports `signedFetch(method, path, body?)` — signs and sends any AuthDeep request (skill §1 outbound HMAC recipe) — and `fetchProducts()`, which calls `signedFetch("GET", "/api/gateway/proxy/harbor-api/products")`. |
| [apps/worker/src/mailer.ts](apps/worker/src/mailer.ts) | Rewritten. No more `writeDigestEmail()` writing to `apps/worker/data/outbox/`. Now `buildDigestEmail()` builds the AuthDeep payload shape (`to`/`subject`/`html_body`/`text_body`), and `sendDigestEmail(lowStock, { dryRun })` posts it via `signedFetch` to `/api/gateway/notifications/email`, expecting `202 { accepted: true }`. `dryRun` short-circuits before the network call and just prints the payload — it needs `AUTHDEEP_DIGEST_TO` but *not* AuthDeep credentials, so it works for local debugging without secrets. |
| [apps/worker/src/run.ts](apps/worker/src/run.ts) | Reads `--dry-run` off `process.argv`, still fetches real products either way (dry-run only skips the send), prints `digest sent` / `dry run — not sent`. |
| [apps/worker/src/digest.ts](apps/worker/src/digest.ts) | Unchanged — `findLowStock` didn't need to change. |

The worker now depends on AuthDeep being reachable even to read product
data — that's the tradeoff of Path C (see PLAN.md's own framing: "that swap
is fake" if Phase 1 wasn't already key-based S2S).

## Env vars

Two independent credential sets — the API verifies inbound, the worker
signs outbound. Neither side needs the other's secret.

| Var | Used by | What it is |
|---|---|---|
| `HARBOR_PORT` | API | Local listen port, unrelated to AuthDeep. |
| `AUTHDEEP_GATEWAY_KEY` | API | `gwk_...` — identifies inbound requests as from the registered `harbor-api` service. |
| `AUTHDEEP_SERVICE_SECRET` | API | `ssk_...` — verifies `X-Gateway-Signature` on inbound requests. |
| `AUTHDEEP_BASE_URL` | Worker | Tenant host, e.g. `https://<tenant-slug>.authdeep.com`. Never `https://app.authdeep.com`. |
| `AUTHDEEP_SERVICE_KEY` | Worker | `sak_...` — sent as `X-API-Key` on every outbound call. |
| `AUTHDEEP_HMAC_SECRET` | Worker | HMAC secret paired with the `sak_`, signs every outbound call. |
| `AUTHDEEP_DIGEST_TO` | Worker | Recipient address for the low-stock digest email. |

All placeholders live in [.env.example](.env.example).

## Where the keys go — never in this chat, never committed

1. **Local `.env`** (gitignored — [.gitignore](.gitignore)): fill in real
   values from `.env.example`'s placeholders.
2. **Wherever each half runs in production** — for the API that's the
   Render dashboard's Environment tab (`AUTHDEEP_GATEWAY_KEY` +
   `AUTHDEEP_SERVICE_SECRET`, already set there as of this integration). For
   the worker, wherever it's actually invoked from (a scheduled job, a
   second Render service, a cron host) — set all four worker vars there.
   Never in the `Dockerfile` or any committed file.

If you have a new secret to hand over, put it directly into one of those two
places yourself — don't paste it into this chat.

## How the API verifies inbound requests

Unchanged from the original gateway work — see skill §9:

```
signed string = METHOD "\n" path "\n" unix_timestamp "\n" sha256hex(raw_body)
```

- `path`: request path only (no query string), trailing slash stripped —
  already stripped of the `/api/gateway/proxy/harbor-api` prefix by AuthDeep
  before it reaches Harbor.
- `X-Gateway-Signature: t=<unix_timestamp>,v1=<hex hmac>`, HMAC-SHA256 keyed
  with `AUTHDEEP_SERVICE_SECRET`.
- `X-Gateway-Key` must equal `AUTHDEEP_GATEWAY_KEY`.
- ±300s clock skew tolerance; `crypto.timingSafeEqual` comparison.
- **Never reads** `X-AuthDeep-User-ID`/`-Email`/`-Roles` to authorize
  anything — only checks whether `X-AuthDeep-User-ID` is present, and logs a
  warning if it is, since Path C must never carry one.

## How the worker signs outbound requests

Same construction, mirrored — skill §1:

```
signed string = METHOD "\n" path+query "\n" unix_timestamp "\n" sha256hex(raw_body)
```

`signedFetch` in `harborClient.ts` builds this for every AuthDeep call,
sending `X-API-Key: <AUTHDEEP_SERVICE_KEY>` and
`X-HMAC-Signature: t=...,v1=...`. It's shared by both `fetchProducts()`
(path `/api/gateway/proxy/harbor-api/products`) and `mailer.ts`'s send
(path `/api/gateway/notifications/email`) — same `sak_`, same signing, only
the path and body differ.

## Verifying the integration

Three tiers, cheapest/safest first. Re-run **Tier 0 after every redeploy or
env var change**.

### Tier 0 — API config sanity (no secrets needed)

```bash
HARBOR_URL=https://harbor-6jd6.onrender.com
GWK=gwk_7d1f876385a4e9e44aa7b1a817428c6fb6703b693a388f5120ea4c5efe000442

echo "1) health, unauthenticated";               curl -s -o /dev/null -w "%{http_code}\n" "$HARBOR_URL/health"                 # expect 200
echo "2) no auth at all";                          curl -s -o /dev/null -w "%{http_code}\n" "$HARBOR_URL/products"               # expect 401
echo "3) old X-Harbor-Key (must now fail — deleted, PLAN.md Phase 2 acceptance)"
curl -s -o /dev/null -w "%{http_code}\n" "$HARBOR_URL/products" -H "X-Harbor-Key: whatever-it-used-to-be"                        # expect 401
echo "4) bogus gateway signature";                 curl -s "$HARBOR_URL/products" -H "X-Gateway-Key: gwk_bogus" -H "X-Gateway-Signature: t=1,v1=deadbeef"
# expect 401 {"error":"unauthorized"} -> both API env vars ARE set
# 500 {"error":"gateway not configured"} -> one is missing on Render; set it and redeploy
echo "5) real gwk_, bad signature";                curl -s "$HARBOR_URL/products" -H "X-Gateway-Key: $GWK" -H "X-Gateway-Signature: t=1,v1=deadbeef"   # expect 401
```

**Last run against this deployment (2026-09-14):** all five passed —
`AUTHDEEP_GATEWAY_KEY` and `AUTHDEEP_SERVICE_SECRET` are both set on Render,
and the old key is confirmed gone (check 3 now returns `401`, where it used
to return `200` before Phase 2).

### Tier 1 — does the API accept a *genuinely* correct signature?

Run locally with your real `ssk_` typed into the shell, never pasted here:

```bash
HARBOR_URL=https://harbor-6jd6.onrender.com
GWK=gwk_7d1f876385a4e9e44aa7b1a817428c6fb6703b693a388f5120ea4c5efe000442
read -s -p "ssk_: " SSK; echo

SIG=$(node -e "
const crypto = require('crypto');
const ts = Math.floor(Date.now()/1000).toString();
const bodyHash = crypto.createHash('sha256').update('').digest('hex');
const payload = 'GET\n/products\n' + ts + '\n' + bodyHash;
const sig = crypto.createHmac('sha256', process.env.SSK).update(payload).digest('hex');
console.log('t=' + ts + ',v1=' + sig);
" SSK="$SSK")

curl -s -w "\nHTTP %{http_code}\n" "$HARBOR_URL/products" -H "X-Gateway-Key: $GWK" -H "X-Gateway-Signature: $SIG"
# expect 200 and the seeded product list
```

Validated during development with a throwaway test secret (not the real
`ssk_`): correctly-signed `GET`/`POST` → `200`; tampered signature / no
auth → `401`; old `X-Harbor-Key` → `401` (confirms it's truly gone, not
just untested); a valid signature carrying a forged `X-AuthDeep-User-ID`
still authenticates (identity headers aren't part of the signature) but
logs `"gateway request authenticated — unexpected User-ID header present"`
— proving the required log line fires and the warning path works.

### Tier 2 — true end-to-end, through AuthDeep itself

The real test for the **worker** specifically — once `AUTHDEEP_BASE_URL`,
`AUTHDEEP_SERVICE_KEY`, `AUTHDEEP_HMAC_SECRET`, `AUTHDEEP_DIGEST_TO` are set
wherever the worker runs:

```bash
npm run digest -- --dry-run   # prints the exact email payload, no send, no AuthDeep call for the send step
npm run digest                # real run: reads products through the proxy, sends via AuthDeep, expect "digest sent"
```

For the API in isolation, the equivalent is any real caller hitting
`<authdeep-base>/api/gateway/proxy/harbor-api/products` with a `sak_` +
HMAC per the skill's §1 outbound recipe — expect `200` with the product
list.

**Validated this session** against a local mock of AuthDeep's contract (a
plain HTTP server that independently recomputes and checks the same
HMAC AuthDeep would, using test `sak_test`/`hmac_test_secret`, on the
`/api/gateway/proxy/harbor-api/products` and
`/api/gateway/notifications/email` routes) — this exercises the *real*
`harborClient.ts`/`mailer.ts`/`run.ts` code, only substituting the mock for
AuthDeep itself:

| Case | Result |
|---|---|
| `npm run digest -- --dry-run` | Printed the correct payload (`GADGET-2`, `BOLT-9`, not `WIDGET-1`); mock received **zero** requests to the notifications route |
| `npm run digest` | `digest sent`; mock verified the HMAC on both the products read and the notification send, payload matched dry-run's |
| `AUTHDEEP_BASE_URL` pointed at a closed port | `fetch failed`, exit `1` |
| `AUTHDEEP_DIGEST_TO` unset | `AUTHDEEP_DIGEST_TO must be set`, exit `1`, before any network call |

This proves the worker's signing math, payload shape, and error handling
are all correct independent of AuthDeep's own behavior. It does **not**
prove AuthDeep's admin-side config (service registration, `sak_`
permissions, tenant SMTP) is correct — only a real Tier 2 run against the
actual tenant proves that.

## Still to do (in AuthDeep, not this repo)

1. **Confirm the registered service config**: `backendUrl =
   https://harbor-6jd6.onrender.com`, `healthPath = /health`.
2. **Mint the `sak_`** with both permissions (PLAN.md Phase 2):
   ```json
   { "permissions": [
     { "serviceId": "<harbor-api service id>", "httpMethod": "*" },
     { "capability": "notifications_email", "httpMethod": "POST" }
   ] }
   ```
   Store the resulting `sak_` + HMAC secret as `AUTHDEEP_SERVICE_KEY` /
   `AUTHDEEP_HMAC_SECRET` wherever the worker runs.
3. **Configure tenant notification delivery** (`provider: smtp` + real SMTP
   fields, or `authdeep_mail`) via `PUT /api/gateway/notifications/settings`
   — without it, sends may `202` but never actually deliver. PLAN.md prefers
   real SMTP so Phase 2 mail is real, not just accepted.
4. **Decide where the worker actually runs** and set its four env vars
   there (a scheduled job, a second Render service, wherever `npm run
   digest` gets invoked on a schedule) — it isn't deployed anywhere yet,
   it's still a CLI you run by hand.

## Troubleshooting

**API side, `401` from the gateway path:**
- Wrong/missing `AUTHDEEP_GATEWAY_KEY`/`AUTHDEEP_SERVICE_SECRET` on Render.
- Clock skew >5 minutes between Render and AuthDeep.
- Path mismatch — signature computed over a path Harbor didn't actually
  receive (check `request.url` in Render logs against what was signed).
- Body mismatch — anything reformatting the JSON between signing and
  receipt breaks the hash; Harbor hashes the exact raw bytes it gets.

**Worker side:**
- `AUTHDEEP_BASE_URL, AUTHDEEP_SERVICE_KEY and AUTHDEEP_HMAC_SECRET must all
  be set` — one of the three is missing; only matters for a real send,
  `--dry-run` doesn't need them.
- `AUTHDEEP_DIGEST_TO must be set` — no recipient configured; also checked
  before `--dry-run`'s print, so dry-run needs this one even though it
  skips the network call.
- `fetch failed` — `AUTHDEEP_BASE_URL` unreachable or wrong.
- `GET /products failed: 403 ...` / `notification send failed: 403 ...` —
  the `sak_` is missing the relevant permission (service `harbor-api` /
  `notifications_email` capability) — see "Still to do" item 2.
- `notification send failed: 202` never happens by definition, but a `202`
  with `accepted: false`, or delivery that never arrives despite `202`, most
  likely means tenant SMTP isn't configured — see "Still to do" item 3.
