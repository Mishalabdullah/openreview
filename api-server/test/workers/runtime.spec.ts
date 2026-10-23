import { describe, expect, it } from "vitest";
import app from "../../src";
import type { Bindings } from "../../src/types/env";
import { OpaqueTokens } from "../../src/lib/github/pagination";
import { z } from "zod";
import { GitHubClient } from "../../src/lib/github/client";
import { defaultGitHubCache, GitHubCache } from "../../src/lib/github/cache";

const bindings: Bindings = {
  ENVIRONMENT: "local",
  BETTER_AUTH_URL: "http://localhost:1337",
  FRONTEND_URL: "http://localhost:5173",
  BETTER_AUTH_SECRET: "workers-runtime-test-secret-12345678901234567890",
  GITHUB_CLIENT_ID: "test-client",
  GITHUB_CLIENT_SECRET: "test-secret",
  GITHUB_WEBHOOK_SECRET: "test-webhook",
  DATABASE_URL: "postgresql://test:test@localhost:1/test",
};

describe("actual Workers runtime", () => {
  it("persists encrypted GitHub responses across request-owned cache handles", async () => {
    const store = defaultGitHubCache();
    expect(store).toBeDefined();
    const user = crypto.randomUUID();
    const cache = () =>
      new GitHubCache(
        store,
        bindings.BETTER_AUTH_SECRET,
        bindings.BETTER_AUTH_URL,
        user,
        "account",
        "token",
      );
    await cache().write("api:overview", '{"data":{"repositoryCount":2}}');
    expect(await cache().read("api:overview")).toMatchObject({
      body: '{"data":{"repositoryCount":2}}',
    });
  });
  it("calls GitHub transport with the global receiver and a Workers-supported redirect mode", async () => {
    let calls = 0;
    const transport: typeof fetch = async function (
      this: unknown,
      input,
      init,
    ) {
      expect(this).toBe(globalThis);
      // Constructing a real Workers Request rejects Node-only redirect: "error".
      const request = new Request(input, init);
      expect(request.redirect).toBe("manual");
      expect(request.headers.get("Authorization")).toBe("Bearer test-token");
      calls++;
      return new Response(JSON.stringify({ id: 1 }), {
        headers: { "Content-Type": "application/json" },
      });
    };
    const result = await new GitHubClient("test-token", transport).get(
      "/user",
      z.object({ id: z.number() }),
    );
    expect(result.data).toEqual({ id: 1 });
    expect(calls).toBe(1);
  });
  it("rejects anonymous GitHub API requests before making any provider/database calls", async () => {
    for (const path of [
      "/github/connection",
      "/repositories",
      "/pull-requests",
      "/dashboard/overview",
    ]) {
      const response = await app.request(
        `http://localhost:1337/api/v1${path}`,
        { headers: { Origin: bindings.FRONTEND_URL } },
        bindings,
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: { code: "SESSION_REQUIRED" },
      });
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        bindings.FRONTEND_URL,
      );
    }
  });

  it("encrypts, validates and rejects cross-user GitHub cursors using Workers crypto", async () => {
    const tokens = new OpaqueTokens(bindings.BETTER_AUTH_SECRET, "one");
    const token = await tokens.seal("repositories", { page: 2 });
    expect(
      await tokens.open("repositories", token, z.object({ page: z.number() })),
    ).toEqual({ page: 2 });
    await expect(
      new OpaqueTokens(bindings.BETTER_AUTH_SECRET, "two").open(
        "repositories",
        token,
        z.object({ page: z.number() }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });
  it("runs the Worker fetch handler", async () => {
    const response = await app.request(
      "http://localhost:1337/health",
      {},
      bindings,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("constructs pg and Better Auth inside a request and rejects missing sessions without DB I/O", async () => {
    const response = await app.request(
      "http://localhost:1337/api/v1/me",
      {},
      bindings,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "SESSION_REQUIRED" },
    });
  });

  it("supports the browser session endpoint with credentialed CORS", async () => {
    const response = await app.request(
      "http://localhost:1337/api/auth/get-session",
      {
        headers: { Origin: bindings.FRONTEND_URL },
      },
      bindings,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      bindings.FRONTEND_URL,
    );
  });

  it("rejects untrusted origins before creating resources", async () => {
    const response = await app.request(
      "http://localhost:1337/api/auth/sign-out",
      {
        method: "POST",
        headers: { Origin: "https://evil.example" },
      },
      bindings,
    );
    expect(response.status).toBe(403);
  });
});
