import { readFile } from "node:fs/promises";
import { URL as NodeURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import { authOptions } from "../src/lib/auth-options";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src";
import { createAuth } from "../src/lib/auth";
import { readConfig, databaseUrl } from "../src/config/env";
import { createDatabase } from "../src/db";
import { requireAuth } from "../src/middleware/auth";
import { requireOrganizationPermission } from "../src/middleware/organization";
import * as schema from "../src/db/auth-schema";
import type { Bindings } from "../src/types/env";

const env: Bindings = {
  ENVIRONMENT: "local",
  BETTER_AUTH_URL: "http://localhost:1337",
  FRONTEND_URL: "http://localhost:5173",
  BETTER_AUTH_SECRET: "test-secret-only-123456789012345678901234567890",
  GITHUB_CLIENT_ID: "test-github-client",
  GITHUB_CLIENT_SECRET: "test-github-secret",
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
};

const storage = new PGlite();
const db = drizzle(storage, { schema });
const auth = createAuth(readConfig(env), db);
const close = vi.fn(async () => {});
const app = createApp({
  createDatabase: () => ({ db, close }),
  createAuth: () => auth,
});

// Test-only resource route exercises the actual authorization helper.
app.use("/api/v1/me/permission/:organizationId", requireAuth);
app.get("/api/v1/me/permission/:organizationId", async (c) => {
  await requireOrganizationPermission(c, c.req.param("organizationId"), {
    organization: ["delete"],
  });
  return c.json({ allowed: true });
});

const headers = (cookie?: string) => ({
  Origin: env.FRONTEND_URL,
  "Content-Type": "application/json",
  ...(cookie ? { Cookie: cookie } : {}),
});
async function request(path: string, cookie?: string, body?: object) {
  return app.request(
    `http://localhost:1337${path}`,
    {
      method: body ? "POST" : "GET",
      headers: headers(cookie),
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    env,
  );
}

let ownerCookie: string;
let memberCookie: string;
let outsiderCookie: string;
let organizationId: string;

async function identity(id: string) {
  await db
    .insert(schema.user)
    .values({ id, name: id, email: `${id}@example.com`, emailVerified: true });
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(id);
  const { makeSignature } = await import("better-auth/crypto");
  const signature = await makeSignature(session.token, env.BETTER_AUTH_SECRET);
  return `better-auth.session_token=${encodeURIComponent(`${session.token}.${signature}`)}`;
}

beforeAll(async () => {
  const sql = await readFile(
    new NodeURL("../drizzle/0000_free_supernaut.sql", import.meta.url),
    "utf8",
  );
  await storage.exec(sql);
  ownerCookie = await identity("owner");
  memberCookie = await identity("member");
  outsiderCookie = await identity("outsider");
});

afterAll(async () => {
  await storage.close();
});

describe("infrastructure and configuration", () => {
  it("serves public health and API info without credentials or DB bindings", async () => {
    expect((await app.request("/health")).status).toBe(200);
    expect(await (await app.request("/api/v1")).json()).toEqual({
      name: "OpenReview API",
      version: "v1",
    });
    expect((await app.request("/")).status).toBe(200);
  });

  it("validates secrets and environment-specific exact origins", () => {
    expect(readConfig(env).ENVIRONMENT).toBe("local");
    expect(() => readConfig({ ...env, BETTER_AUTH_SECRET: "" })).toThrow(
      "Invalid backend",
    );
    expect(() =>
      readConfig({ ...env, FRONTEND_URL: "https://openreview.si" }),
    ).toThrow();
    expect(() =>
      readConfig({
        ...env,
        FRONTEND_URL: "http://localhost:5173/" as Bindings["FRONTEND_URL"],
      }),
    ).toThrow();
  });

  it("uses DATABASE_URL directly in every environment", () => {
    for (const environment of ["local", "dev", "production"] as const) {
      expect(databaseUrl({ ...env, ENVIRONMENT: environment })).toBe(
        env.DATABASE_URL,
      );
      for (const value of [undefined, "", "https://example.com", "not-a-url"])
        expect(() =>
          databaseUrl({
            ...env,
            ENVIRONMENT: environment,
            DATABASE_URL: value,
          }),
        ).toThrow("DATABASE_URL");
    }
  });

  it("uses a lazy request-owned pool and allows cleanup without connecting", async () => {
    const resource = createDatabase(env);
    await expect(resource.close()).resolves.toBeUndefined();
  });

  it("propagates database connectivity failures and still permits cleanup", async () => {
    const resource = createDatabase({
      ...env,
      DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test",
    });
    try {
      await expect(resource.db.execute(sql`select 1`)).rejects.toThrow();
    } finally {
      await resource.close();
    }
  });

  it("returns generic errors and closes resources on failure", async () => {
    const cleanup = vi.fn(async () => {});
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = createApp({
      createDatabase: () => ({ db, close: cleanup }),
      createAuth: () => {
        throw new Error("private database credentials");
      },
    });
    const response = await failing.request("/api/v1/me", {}, env);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private");
    expect(cleanup).toHaveBeenCalledOnce();
    logger.mockRestore();
  });

  it("rejects unsigned webhooks", async () => {
    expect(
      (await request("/api/v1/webhooks/github", undefined, {})).status,
    ).toBe(401);
  });
});

describe("authentication", () => {
  it("returns 401 without a session or with an invalid session", async () => {
    expect((await request("/api/v1/me")).status).toBe(401);
    expect(
      (await request("/api/v1/me", "better-auth.session_token=invalid")).status,
    ).toBe(401);
  });

  it("reads sessions through Better Auth and returns only public user fields", async () => {
    const spy = vi.spyOn(auth.api, "getSession");
    close.mockClear();
    const response = await request("/api/v1/me", ownerCookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { id: "owner", email: "owner@example.com" },
    });
    expect(spy).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    spy.mockRestore();
  });

  it("sets credentialed CORS only for the configured frontend", async () => {
    const response = await request("/api/auth/get-session", ownerCookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      env.FRONTEND_URL,
    );
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
      "true",
    );
    const preflight = await app.request(
      "/api/auth/sign-in/social",
      { method: "OPTIONS", headers: headers() },
      env,
    );
    expect(preflight.status).toBe(204);
  });

  it("rejects hostile origins for auth and application routes", async () => {
    for (const path of ["/api/v1/me", "/api/auth/sign-out"]) {
      const response = await app.request(
        path,
        { method: "POST", headers: { Origin: "https://evil.example" } },
        env,
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
  });

  it("keeps Better Auth CSRF enforcement enabled for cookie-bearing mutations", async () => {
    const response = await app.request(
      "/api/auth/sign-out",
      {
        method: "POST",
        headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
        body: "{}",
      },
      env,
    );
    expect(response.status).toBe(403);
  });

  it("uses secure host-only cookies and environment-specific OAuth origins", () => {
    for (const config of [
      {
        ...env,
        ENVIRONMENT: "dev" as const,
        BETTER_AUTH_URL: "https://api.dev.openreview.si" as const,
        FRONTEND_URL: "https://dev.openreview.si" as const,
      },
      {
        ...env,
        ENVIRONMENT: "production" as const,
        BETTER_AUTH_URL: "https://api.openreview.si" as const,
        FRONTEND_URL: "https://openreview.si" as const,
      },
    ]) {
      const options = authOptions(readConfig(config));
      expect(options.baseURL).toBe(config.BETTER_AUTH_URL);
      expect(options.advanced.useSecureCookies).toBe(true);
      expect(options.advanced.defaultCookieAttributes).toEqual({
        httpOnly: true,
        sameSite: "lax",
      });
      expect(options.advanced.crossSubDomainCookies.enabled).toBe(false);
    }
  });

  it("rejects expired sessions", async () => {
    const cookie = await identity("expired");
    await db
      .update(schema.session)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.session.userId, "expired"));
    expect((await request("/api/v1/me", cookie)).status).toBe(401);
  });

  it("generates the intended GitHub callback and validates callback destinations", async () => {
    const response = await request("/api/auth/sign-in/social", undefined, {
      provider: "github",
      callbackURL: `${env.FRONTEND_URL}/dashboard`,
      disableRedirect: true,
    });
    expect(response.status).toBe(200);
    const data = (await response.json()) as { url: string };
    const url = new URL(data.url);
    expect(url.origin).toBe("https://github.com");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${env.BETTER_AUTH_URL}/api/auth/callback/github`,
    );
    expect(url.searchParams.get("state")).toBeTruthy();
    const invalid = await request("/api/auth/sign-in/social", undefined, {
      provider: "github",
      callbackURL: "https://evil.example/dashboard",
    });
    expect(invalid.status).toBe(403);
  });

  it("does not expose OAuth token endpoints", async () => {
    for (const path of ["get-access-token", "refresh-token"]) {
      expect(
        (
          await request(`/api/auth/${path}`, ownerCookie, {
            providerId: "github",
          })
        ).status,
      ).toBe(404);
    }
  });

  it("sign-out revokes a persisted session", async () => {
    const cookie = await identity("logout");
    expect((await request("/api/v1/me", cookie)).status).toBe(200);
    const response = await request("/api/auth/sign-out", cookie, {});
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await request("/api/v1/me", cookie)).status).toBe(401);
  });
});

describe("organizations using real Better Auth authorization", () => {
  it("creates organizations and teams with the default owner role", async () => {
    const response = await request(
      "/api/auth/organization/create",
      ownerCookie,
      { name: "Workspace", slug: "workspace" },
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as { id: string };
    organizationId = data.id;
    const [membership] = await db
      .select()
      .from(schema.member)
      .where(eq(schema.member.organizationId, organizationId));
    expect(membership.role).toBe("owner");
    expect(
      (
        await request("/api/auth/organization/create-team", ownerCookie, {
          name: "Engineering",
          organizationId,
        })
      ).status,
    ).toBe(200);
  });

  it("invites a verified user, who can discover and accept the invitation", async () => {
    const response = await request(
      "/api/auth/organization/invite-member",
      ownerCookie,
      {
        organizationId,
        email: "member@example.com",
        role: "member",
      },
    );
    expect(response.status).toBe(200);
    const invitation = (await response.json()) as { id: string };
    const listed = await request(
      "/api/auth/organization/list-user-invitations",
      memberCookie,
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject([{ id: invitation.id }]);
    expect(
      (
        await request(
          "/api/auth/organization/accept-invitation",
          outsiderCookie,
          { invitationId: invitation.id },
        )
      ).status,
    ).not.toBe(200);
    expect(
      (
        await request(
          "/api/auth/organization/accept-invitation",
          memberCookie,
          { invitationId: invitation.id },
        )
      ).status,
    ).toBe(200);
  });

  it("lists only organizations the caller belongs to", async () => {
    const response = await request("/api/v1/me/organizations", memberCookie);
    expect(await response.json()).toMatchObject({
      organizations: [{ id: organizationId }],
    });
    expect(
      await (await request("/api/v1/me/organizations", outsiderCookie)).json(),
    ).toEqual({ organizations: [] });
    const forbidden = await request(
      `/api/auth/organization/get-full-organization?organizationId=${organizationId}`,
      outsiderCookie,
    );
    expect(forbidden.status).not.toBe(200);
  });

  it("does not allow organization IDs to bypass active workspace membership", async () => {
    expect(
      (
        await request("/api/auth/organization/set-active", memberCookie, {
          organizationId,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("/api/auth/organization/set-active", outsiderCookie, {
          organizationId,
        })
      ).status,
    ).not.toBe(200);
  });

  it("rejects member deletion, role escalation, invitation and removal attempts", async () => {
    const [owner] = await db
      .select()
      .from(schema.member)
      .where(eq(schema.member.userId, "owner"));
    for (const [path, body] of [
      ["delete", { organizationId }],
      [
        "update-member-role",
        { organizationId, memberId: owner.id, role: "member" },
      ],
      ["remove-member", { organizationId, memberIdOrEmail: owner.id }],
      [
        "invite-member",
        { organizationId, email: "other@example.com", role: "owner" },
      ],
    ] as const) {
      expect(
        (await request(`/api/auth/organization/${path}`, memberCookie, body))
          .status,
      ).not.toBe(200);
    }
  });

  it("checks both membership and Better Auth permissions for future resources", async () => {
    expect(
      (await request(`/api/v1/me/permission/${organizationId}`, ownerCookie))
        .status,
    ).toBe(200);
    expect(
      (await request(`/api/v1/me/permission/${organizationId}`, memberCookie))
        .status,
    ).toBe(403);
    expect(
      (await request(`/api/v1/me/permission/${organizationId}`, outsiderCookie))
        .status,
    ).toBe(403);
    expect(
      (await request("/api/v1/me/permission/arbitrary-id", ownerCookie)).status,
    ).toBe(403);
  });

  it("allows owner updates and invitation rejection but protects the last owner", async () => {
    expect(
      (
        await request("/api/auth/organization/update", ownerCookie, {
          organizationId,
          data: { name: "Updated workspace" },
        })
      ).status,
    ).toBe(200);
    const invited = await request(
      "/api/auth/organization/invite-member",
      ownerCookie,
      {
        organizationId,
        email: "outsider@example.com",
        role: "member",
      },
    );
    expect(invited.status).toBe(200);
    const invitation = (await invited.json()) as { id: string };
    expect(
      (
        await request(
          "/api/auth/organization/reject-invitation",
          outsiderCookie,
          { invitationId: invitation.id },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request("/api/auth/organization/leave", ownerCookie, {
          organizationId,
        })
      ).status,
    ).not.toBe(200);
    expect(
      (
        await request("/api/auth/organization/leave", memberCookie, {
          organizationId,
        })
      ).status,
    ).toBe(200);
    expect(
      await (await request("/api/v1/me/organizations", memberCookie)).json(),
    ).toEqual({ organizations: [] });
  });
});
