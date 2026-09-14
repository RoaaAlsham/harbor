import { createHash, createHmac } from "node:crypto";

const AUTHDEEP_BASE_URL = process.env.AUTHDEEP_BASE_URL ?? "";
const AUTHDEEP_SERVICE_KEY = process.env.AUTHDEEP_SERVICE_KEY ?? "";
const AUTHDEEP_HMAC_SECRET = process.env.AUTHDEEP_HMAC_SECRET ?? "";

export interface Product {
  id: number;
  sku: string;
  name: string;
  quantity: number;
  reorder_at: number;
  updated_at: string;
}

/**
 * Signs and sends an authenticated AuthDeep request (gateway-integration
 * skill §1 outbound HMAC recipe: METHOD\npath+query\ntimestamp\nsha256hex(body),
 * sak_ + X-HMAC-Signature). Shared by product reads (proxied to the
 * harbor-api gateway service) and notification email sends (a platform
 * route) — same sak_, same signing, different paths.
 */
export async function signedFetch(
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  if (!AUTHDEEP_BASE_URL || !AUTHDEEP_SERVICE_KEY || !AUTHDEEP_HMAC_SECRET) {
    throw new Error(
      "AUTHDEEP_BASE_URL, AUTHDEEP_SERVICE_KEY and AUTHDEEP_HMAC_SECRET must all be set"
    );
  }

  const signedPath = path.startsWith("/") ? path : `/${path}`;
  const rawBody = body === undefined ? "" : JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  const payload = `${method}\n${signedPath}\n${timestamp}\n${bodyHash}`;
  const signature = createHmac("sha256", AUTHDEEP_HMAC_SECRET).update(payload).digest("hex");

  return fetch(`${AUTHDEEP_BASE_URL}${signedPath}`, {
    method,
    headers: {
      "X-API-Key": AUTHDEEP_SERVICE_KEY,
      "X-HMAC-Signature": `t=${timestamp},v1=${signature}`,
      ...(rawBody ? { "Content-Type": "application/json" } : {}),
    },
    body: rawBody || undefined,
  });
}

export async function fetchProducts(): Promise<Product[]> {
  const response = await signedFetch("GET", "/api/gateway/proxy/harbor-api/products");

  if (!response.ok) {
    throw new Error(`GET /products failed: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as { products: Product[] };
  return body.products;
}
