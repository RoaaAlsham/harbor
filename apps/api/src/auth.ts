import type { FastifyReply, FastifyRequest } from "fastify";

const HARBOR_API_KEY = process.env.HARBOR_API_KEY ?? "";

export function requireApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
  done: (err?: Error) => void
) {
  const key = request.headers["x-harbor-key"];
  if (!key || key !== HARBOR_API_KEY) {
    reply.code(401).send({ error: "unauthorized" });
    return;
  }
  done();
}
