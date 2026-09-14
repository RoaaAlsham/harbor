import "./env.js";
import Fastify from "fastify";
import { registerHealthRoutes } from "./health.js";
import { registerProductRoutes } from "./products.js";
import "./db.js";

const port = Number(process.env.PORT ?? process.env.HARBOR_PORT ?? 8788);

const app = Fastify({ logger: true });

// Gateway signature verification (auth.ts) needs the exact bytes AuthDeep
// signed, so capture the raw body alongside the parsed JSON.
app.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  (request, body, done) => {
    request.rawBody = body as string;
    if (!body) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  }
);

registerHealthRoutes(app);
app.register(async (instance) => {
  registerProductRoutes(instance);
});

app
  .listen({ port, host: "0.0.0.0" })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
