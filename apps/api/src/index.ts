import Fastify from "fastify";
import { registerHealthRoutes } from "./health.js";
import { registerProductRoutes } from "./products.js";
import "./db.js";

const port = Number(process.env.HARBOR_PORT ?? 8788);

const app = Fastify({ logger: true });

registerHealthRoutes(app);
app.register(async (instance) => {
  registerProductRoutes(instance);
});

app
  .listen({ port, host: "127.0.0.1" })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
