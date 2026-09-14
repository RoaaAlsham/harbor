import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

const HARBOR_API_KEY = process.env.HARBOR_API_KEY ?? "";
const GATEWAY_KEY = process.env.AUTHDEEP_GATEWAY_KEY ?? "";
const GATEWAY_SECRET = process.env.AUTHDEEP_SERVICE_SECRET ?? "";
const CLOCK_SKEW_SECS = 300;

export interface GatewayIdentity {
  tenantId?: string;
  apiKeyId?: string;
  apiKeyType?: string;
  userId?: string;
  userEmail?: string;
  userRoles?: string;
  authType?: string;
  requestId?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
    gateway?: GatewayIdentity;
  }
}

function headerString(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * Verifies AuthDeep gateway proxy requests (docs §9): the gateway signs
 * every hop with the service's ssk_ so the backend can trust the identity
 * headers it injects instead of the caller's own headers.
 */
function verifyGatewaySignature(
  request: FastifyRequest,
  reply: FastifyReply,
  done: (err?: Error) => void
) {
  if (!GATEWAY_KEY || !GATEWAY_SECRET) {
    reply.code(500).send({ error: "gateway not configured" });
    return;
  }

  const signatureHeader = headerString(request, "x-gateway-signature");
  const match = signatureHeader ? /^t=(\d+),v1=([0-9a-f]+)$/.exec(signatureHeader) : null;

  if (headerString(request, "x-gateway-key") !== GATEWAY_KEY || !match) {
    reply.code(401).send({ error: "unauthorized" });
    return;
  }

  const [, timestampStr, providedSignature] = match;
  const skewSecs = Math.abs(Date.now() / 1000 - Number(timestampStr));
  if (!Number.isFinite(skewSecs) || skewSecs > CLOCK_SKEW_SECS) {
    reply.code(401).send({ error: "unauthorized" });
    return;
  }

  const path = request.url.split("?")[0].replace(/\/+$/, "") || "/";
  const bodyHash = createHash("sha256").update(request.rawBody ?? "").digest("hex");
  const payload = `${request.method}\n${path}\n${timestampStr}\n${bodyHash}`;
  const expected = createHmac("sha256", GATEWAY_SECRET).update(payload).digest();
  const provided = Buffer.from(providedSignature, "hex");

  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    reply.code(401).send({ error: "unauthorized" });
    return;
  }

  request.gateway = {
    tenantId: headerString(request, "x-authdeep-tenant-id"),
    apiKeyId: headerString(request, "x-authdeep-api-key-id"),
    apiKeyType: headerString(request, "x-authdeep-api-key-type"),
    userId: headerString(request, "x-authdeep-user-id"),
    userEmail: headerString(request, "x-authdeep-user-email"),
    userRoles: headerString(request, "x-authdeep-user-roles"),
    authType: headerString(request, "x-authdeep-auth-type"),
    requestId: headerString(request, "x-gateway-request-id"),
  };

  done();
}

/**
 * Accepts either an AuthDeep gateway-signed request (identified by the
 * presence of X-Gateway-Key) or a direct caller presenting X-Harbor-Key —
 * the worker and manual testing still use the latter.
 */
export function requireApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
  done: (err?: Error) => void
) {
  if (headerString(request, "x-gateway-key")) {
    verifyGatewaySignature(request, reply, done);
    return;
  }

  const key = request.headers["x-harbor-key"];
  if (!key || key !== HARBOR_API_KEY) {
    reply.code(401).send({ error: "unauthorized" });
    return;
  }
  done();
}
