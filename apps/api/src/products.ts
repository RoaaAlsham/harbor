import type { FastifyInstance } from "fastify";
import { db } from "./db.js";
import { requireApiKey } from "./auth.js";

interface Product {
  id: number;
  sku: string;
  name: string;
  quantity: number;
  reorder_at: number;
  updated_at: string;
}

const listStmt = db.prepare<[], Product>("SELECT * FROM products ORDER BY sku");
const getStmt = db.prepare<[string], Product>("SELECT * FROM products WHERE sku = ?");
const adjustStmt = db.prepare<[number, string, string], void>(
  "UPDATE products SET quantity = ?, updated_at = ? WHERE sku = ?"
);

export function registerProductRoutes(app: FastifyInstance) {
  // preHandler, not onRequest: gateway signature verification needs the
  // parsed request body (see rawBody capture in index.ts).
  app.addHook("preHandler", requireApiKey);

  app.get("/products", async () => {
    return { products: listStmt.all() };
  });

  app.get<{ Params: { sku: string } }>("/products/:sku", async (request, reply) => {
    const product = getStmt.get(request.params.sku);
    if (!product) {
      return reply.code(404).send({ error: "not found" });
    }
    return product;
  });

  app.post<{ Params: { sku: string }; Body: { delta: number } }>(
    "/products/:sku/adjust",
    async (request, reply) => {
      const product = getStmt.get(request.params.sku);
      if (!product) {
        return reply.code(404).send({ error: "not found" });
      }

      const delta = request.body?.delta;
      if (typeof delta !== "number" || !Number.isFinite(delta)) {
        return reply.code(400).send({ error: "delta must be a number" });
      }

      const quantity = Math.max(0, product.quantity + delta);
      const updatedAt = new Date().toISOString();
      adjustStmt.run(quantity, updatedAt, product.sku);

      return getStmt.get(product.sku);
    }
  );
}
