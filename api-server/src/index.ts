import { Hono, type Context, type Next } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { readConfig } from "./config/env";
import { createDatabase } from "./db";
import { createAuth } from "./lib/auth";
import { me } from "./routes/me";
import type { AppEnv } from "./types/env";
import type { Database } from "./db";
import { ApiError, apiErrorResponse } from "./lib/api-error";
import { githubRoutes } from "./routes/github";

type Dependencies = {
  createDatabase: (env: AppEnv["Bindings"]) => {
    db: Database;
    close: () => Promise<void>;
  };
  createAuth: typeof createAuth;
  githubFetch?: typeof fetch;
};

// Factories are injectable for tests; production always uses pg + Hyperdrive.
export function createApp(
  dependencies: Dependencies = { createDatabase, createAuth },
) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("requestId", crypto.randomUUID());
    c.header("X-Request-ID", c.var.requestId);
    await next();
  });

  app.onError((error, c) => {
    if (error instanceof ApiError) return apiErrorResponse(c, error);
    if (error instanceof HTTPException)
      return c.json({ error: error.message }, error.status);
    console.error(
      JSON.stringify({ event: "request_failed", method: c.req.method }),
    );
    return apiErrorResponse(
      c,
      new ApiError(500, "INTERNAL_ERROR", "Internal server error"),
    );
  });
  app.notFound((c) =>
    apiErrorResponse(
      c,
      new ApiError(404, "RESOURCE_NOT_FOUND", "Resource not found"),
    ),
  );

  app.get("/", (c) => {
    return c.text("Hello Hono!");
  });

  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/api/v1", (c) => c.json({ name: "OpenReview API", version: "v1" }));

  app.use("/api/*", async (c, next) => {
    const config = readConfig(c.env);
    c.set("config", config);
    const origin = c.req.header("Origin");
    if (
      origin &&
      origin !== config.FRONTEND_URL &&
      origin !== config.BETTER_AUTH_URL
    ) {
      return apiErrorResponse(
        c,
        new ApiError(403, "ORIGIN_NOT_ALLOWED", "Origin not allowed"),
      );
    }
    c.header("Cache-Control", "no-store");
    return cors({
      origin: config.FRONTEND_URL,
      credentials: true,
      exposeHeaders: ["X-Request-ID", "Retry-After"],
      allowHeaders: ["Content-Type"],
      allowMethods: ["GET", "POST", "OPTIONS"],
      maxAge: 600,
    })(c, next);
  });

  app.use(
    "/api/auth/*",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => c.json({ error: "Request body too large" }, 413),
    }),
  );

  const resources = async (c: Context<AppEnv>, next: Next) => {
    const resource = dependencies.createDatabase(c.env);
    try {
      c.set("db", resource.db);
      c.set("auth", dependencies.createAuth(c.var.config, resource.db));
      await next();
    } finally {
      // Await cleanup even on auth/database failures; never retain pools in an isolate.
      await resource.close();
    }
  };
  app.use("/api/auth/*", resources);
  app.use("/api/v1/me/*", resources);
  app.use("/api/v1/github/*", resources);
  app.use("/api/v1/repositories/*", resources);
  app.use("/api/v1/pull-requests/*", resources);
  app.use("/api/v1/dashboard/*", resources);

  app.all("/api/auth/*", (c) => c.var.auth.handler(c.req.raw));
  app.route("/api/v1/me", me);
  app.route("/api/v1", githubRoutes(dependencies.githubFetch));

  // Reserved only: nothing is verified, accepted or processed until a durable queue exists.
  app.post("/api/v1/webhooks/github", (c) =>
    c.json({ error: "Webhook ingestion is not enabled" }, 501),
  );

  return app;
}

export default createApp();
