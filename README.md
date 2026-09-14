# Harbor

Harbor is an internal ops tool: an HTTP API of products/stock, plus a CLI
worker that finds low-stock items and emails a digest.

- **API** — Fastify + SQLite (`better-sqlite3`). Every route except
  `/health` is reachable only through an AuthDeep API gateway, which signs
  each proxied request; the API verifies that signature.
- **Worker** — a Node CLI that reads products and sends the digest, both via
  AuthDeep (`sak_` + HMAC) — no direct calls to the API, no SMTP config.

There is no browser app and no user login — Harbor is a machine-to-machine
tool, and AuthDeep never forwards a human identity to it (Path C: API-key
callers only, see [AUTHDEEP_INTEGRATION.md](AUTHDEEP_INTEGRATION.md)).

## Install

```bash
npm install
```

## Configure

Copy the example env file and fill in the real values (see
[AUTHDEEP_INTEGRATION.md](AUTHDEEP_INTEGRATION.md) for where each one comes
from and where to store it):

```bash
cp .env.example .env
```

```
HARBOR_PORT=8788

# API — verifies inbound AuthDeep gateway signatures
AUTHDEEP_GATEWAY_KEY=
AUTHDEEP_SERVICE_SECRET=

# Worker — calls AuthDeep for product reads and digest email
AUTHDEEP_BASE_URL=
AUTHDEEP_SERVICE_KEY=
AUTHDEEP_HMAC_SECRET=
AUTHDEEP_DIGEST_TO=
```

## Seed the database

Creates/updates four sample products (idempotent):

```bash
npm run seed
```

| SKU | Name | Qty | Reorder at |
|-----|------|-----|------------|
| `WIDGET-1` | Widget | 100 | 10 |
| `GADGET-2` | Gadget | 3 | 10 |
| `BOLT-9` | Bolt | 0 | 5 |
| `CRATE-4` | Crate | 50 | 5 |

`GADGET-2` and `BOLT-9` start below their reorder point.

## Start the API

```bash
npm run dev:api
```

Listens on `http://127.0.0.1:8788`. Every route except `/health` requires a
valid AuthDeep gateway signature (`X-Gateway-Key` + `X-Gateway-Signature`);
missing or invalid ones get `401`, and an unconfigured gateway gets `500`.
There is no standalone API key you can curl with directly — see
[AUTHDEEP_INTEGRATION.md](AUTHDEEP_INTEGRATION.md) for signed-request
examples (local test signature, and the real gateway proxy path).

### Routes

| Method | Path | Body | Result |
|--------|------|------|--------|
| GET | `/health` | — | `{ ok: true }` (no auth needed) |
| GET | `/products` | — | `{ products: [...] }` |
| GET | `/products/:sku` | — | product or `404` |
| POST | `/products/:sku/adjust` | `{ "delta": number }` | updated product (quantity clamped at 0) |

## Run the digest worker

```bash
npm run digest
```

1. Reads products through the AuthDeep gateway proxy.
2. Keeps rows where `quantity <= reorder_at`.
3. If none: prints `no low stock`, exits `0`.
4. If some: sends the digest via `POST /api/gateway/notifications/email`
   (AuthDeep), to `AUTHDEEP_DIGEST_TO`. Prints `digest sent` on success
   (`202`), exits `0`.
5. Add `--dry-run` to build and print the exact email payload without
   sending it — still reads real product data, just skips the send.
6. Network/API/AuthDeep failure: exits `1`, message on stderr.

`apps/worker/src/harborClient.ts` is the only module that knows the AuthDeep
base URL and service key; it exports a shared `signedFetch` that both
product reads and `mailer.ts`'s email send use.

## AuthDeep gateway

Full integration record — what changed, why, where secrets live, and how to
verify it's working — is in [AUTHDEEP_INTEGRATION.md](AUTHDEEP_INTEGRATION.md).

## Project layout

```
harbor/
├── apps/
│   ├── api/       Fastify + SQLite HTTP API (apps/api/src)
│   └── worker/    CLI digest worker (apps/worker/src)
└── scripts/
    └── seed.mjs   Idempotent product seed
```
