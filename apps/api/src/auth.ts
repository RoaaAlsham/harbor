import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

const GATEWAY_KEY = process.env.AUTHDEEP_GATEWAY_KEY ?? "";
const GATEWAY_SECRET = process.env.AUTHDEEP_SERVICE_SECRET ?? "";
const CLOCK_SKEW_SECS = 300;

export interface GatewayIdentity {
  tenantId?: string;
  apiKeyId?: string;
  apiKeyType?: string;
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
 * Path C only (gateway-integration skill §6/§9): the AuthDeep gateway is the
 * sole caller Harbor trusts, proxying sak_/cak_-authenticated requests and
 * signing each hop with ssk_. Path C never carries a human identity, so
 * User-ID/Email/Roles are never read for authorization here — only their
 * presence is logged, since that would indicate a misconfigured gateway.
 */
export function requireGatewaySignature(
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

  const authType = headerString(request, "x-authdeep-auth-type");
  const apiKeyType = headerString(request, "x-authdeep-api-key-type");
  const userIdPresent = Boolean(headerString(request, "x-authdeep-user-id"));

  request.gateway = {
    tenantId: headerString(request, "x-authdeep-tenant-id"),
    apiKeyId: headerString(request, "x-authdeep-api-key-id"),
    apiKeyType,
    authType,
    requestId: headerString(request, "x-gateway-request-id"),
  };

  request.log.info(
    { auth_type: authType, api_key_type: apiKeyType, user_id_present: userIdPresent },
    userIdPresent
      ? "gateway request authenticated — unexpected User-ID header present"
      : "gateway request authenticated"
  );

  done();
}
