# Harbor

Harbor is an internal ops tool: an HTTP API of products/stock, plus a CLI
worker that finds low-stock items and writes an email digest.

- **API** — Fastify + SQLite (`better-sqlite3`), key-based auth via
  `X-Harbor-Key`.
- **Worker** — a Node CLI that calls the API, filters low-stock products,
  and writes an HTML email file to an outbox directory (no SMTP required).

There is no browser app and no user login — Harbor is a machine-to-machine
tool.

## Install

```bash
npm install
```

## Configure

Copy the example env file and adjust if needed:

```bash
cp .env.example .env
```

```
HARBOR_PORT=8788
HARBOR_API_KEY=dev-harbor-key-change-me
HARBOR_API_URL=http://127.0.0.1:8788
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

Listens on `http://127.0.0.1:8788`. Every route except `/health` requires
the `X-Harbor-Key` header; missing or wrong keys get `401`.

```bash
curl -s http://127.0.0.1:8788/products -H "X-Harbor-Key: dev-harbor-key-change-me"
```

### Routes

| Method | Path | Body | Result |
|--------|------|------|--------|
| GET | `/health` | — | `{ ok: true }` (no key needed) |
| GET | `/products` | — | `{ products: [...] }` |
| GET | `/products/:sku` | — | product or `404` |
| POST | `/products/:sku/adjust` | `{ "delta": number }` | updated product (quantity clamped at 0) |

## Run the digest worker

With the API running:

```bash
npm run digest
```

- If nothing is low on stock, it prints `no low stock` and exits `0`
  without writing a file.
- If something is low, it writes
  `apps/worker/data/outbox/digest-<ISO-timestamp>.html`, prints the file
  path, and exits `0`. Open the file in a browser to read the digest.
- If the API is unreachable, it exits `1` with an error on stderr.

`apps/worker/src/harborClient.ts` is the only module that knows the API
URL and key.

## AuthDeep gateway

The API also accepts requests proxied through an AuthDeep API gateway
(`/api/gateway/proxy/harbor-api/...`), verifying the gateway's signature
instead of `X-Harbor-Key`. See [AUTHDEEP_INTEGRATION.md](AUTHDEEP_INTEGRATION.md).

## Project layout

```
harbor/
├── apps/
│   ├── api/       Fastify + SQLite HTTP API (apps/api/src)
│   └── worker/    CLI digest worker (apps/worker/src)
└── scripts/
    └── seed.mjs   Idempotent product seed
```
