import { readFile } from "node:fs/promises";
import { URL as NodeURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import {
  makeSignature,
  symmetricEncrypt,
  symmetricDecrypt,
} from "better-auth/crypto";
import { z } from "zod";
import { createApp } from "../src";
import { createAuth } from "../src/lib/auth";
import { readConfig } from "../src/config/env";
import { GitHubService } from "../src/lib/github/service";
import { OpaqueTokens, fingerprint } from "../src/lib/github/pagination";
import * as schema from "../src/db/auth-schema";
import type { Bindings } from "../src/types/env";

const env: Bindings = {
  ENVIRONMENT: "local",
  BETTER_AUTH_URL: "http://localhost:1337",
  FRONTEND_URL: "http://localhost:5173",
  BETTER_AUTH_SECRET: "github-tests-only-secret-12345678901234567890",
  GITHUB_CLIENT_ID: "test-client",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  GITHUB_WEBHOOK_SECRET: "test-webhook",
  GITHUB_APP_SLUG: "openreview-test",
};
const storage = new PGlite();
const db = drizzle(storage, { schema });
const auth = createAuth(readConfig(env), db);
let cookie: string;
let otherCookie: string;
let mode = "normal";

const owner = {
  id: 123,
  login: "octocat",
  avatar_url: "https://avatars.githubusercontent.com/u/123",
  html_url: "https://github.com/octocat",
};
const installation = (id: number) => ({
  id,
  account: { login: `owner${id}`, type: "Organization" },
  repository_selection: "selected",
  suspended_at: null,
});
const repo = (id: number) => ({
  id,
  name: `repo${id}`,
  full_name: `owner${id}/repo${id}`,
  owner: { login: `owner${id}`, avatar_url: null },
  description: null,
  html_url: `https://github.com/owner${id}/repo${id}`,
  private: true,
  default_branch: "main",
  language: null,
  archived: id === 2,
  updated_at: "2026-10-23T12:00:00Z",
  permissions: { pull: true, push: false, admin: false },
  open_issues_count: 999,
});
const pr = (
  repositoryId: number,
  number: number,
  updated: string,
  merged = false,
) => ({
  id: repositoryId * 100 + number,
  number,
  title: `PR ${repositoryId}/${number}`,
  html_url: `https://github.com/owner${repositoryId}/repo${repositoryId}/pull/${number}`,
  state: merged ? "closed" : "open",
  draft: false,
  user: owner,
  head: { ref: "feature", sha: "abcdef" },
  base: { ref: "main", sha: "123456" },
  labels: [],
  created_at: updated,
  updated_at: updated,
  closed_at: merged ? updated : null,
  merged_at: merged ? updated : null,
  body: null,
  additions: 4,
  deletions: 2,
  changed_files: 1,
  mergeable: null,
});
const prs = [
  pr(1, 1, "2026-10-23T12:00:00Z"),
  pr(2, 2, "2026-10-22T12:00:00Z", true),
  pr(1, 3, "2026-10-21T12:00:00Z"),
];
const json = (data: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const fetcher = vi.fn<typeof fetch>(async (input, init) => {
  const url = new URL(String(input));
  expect(url.origin).toBe("https://api.github.com");
  expect(new Headers(init?.headers).get("Authorization")).toBe(
    "Bearer backend-only-token",
  );
  if (mode === "expired") return json({}, 401);
  if (mode === "rate-limit")
    return json({}, 403, { "x-ratelimit-remaining": "0", "retry-after": "37" });
  if (mode === "unavailable") throw new Error("private upstream token details");
  if (url.pathname === "/user") return json(owner);
  if (url.pathname === "/user/installations")
    return json({
      total_count: mode === "no-installations" ? 0 : 1,
      installations: mode === "no-installations" ? [] : [installation(10)],
    });
  if (url.pathname === "/user/installations/10/repositories") {
    return json({
      total_count: mode === "revoked" ? 1 : 2,
      repositories: mode === "revoked" ? [repo(2)] : [repo(1), repo(2)],
    });
  }
  if (url.pathname === "/search/issues") {
    let items = prs.filter(
      (item) =>
        !url.searchParams.get("q")?.includes("is:open") ||
        item.state === "open",
    );
    if (url.searchParams.get("q")?.includes("is:merged"))
      items = items.filter((item) => item.merged_at);
    if (!url.searchParams.get("q")?.includes("repo:owner1/repo1"))
      items = items.filter((item) => item.id >= 200);
    if (!url.searchParams.get("q")?.includes("repo:owner2/repo2"))
      items = items.filter((item) => item.id < 200);
    if (url.searchParams.get("order") === "asc") items.reverse();
    return json({
      total_count: items.length,
      incomplete_results:
        mode === "incomplete" ||
        (mode === "count-incomplete" &&
          url.searchParams.get("per_page") === "1"),
      items: items.map((item) => ({
        id: item.id,
        number: item.number,
        created_at: item.created_at,
        updated_at: item.updated_at,
        repository_url: `https://api.github.com/repos/owner${item.id < 200 ? 1 : 2}/repo${item.id < 200 ? 1 : 2}`,
        pull_request: {
          url: `https://api.github.com/repos/owner${item.id < 200 ? 1 : 2}/repo${item.id < 200 ? 1 : 2}/pulls/${item.number}`,
        },
      })),
    });
  }
  const files = /^\/repos\/owner(\d+)\/repo\d+\/pulls\/(\d+)\/files$/.exec(
    url.pathname,
  );
  if (files)
    return json([
      {
        filename: "binary.png",
        status: "modified",
        additions: 0,
        deletions: 0,
      },
    ]);
  const detail = /^\/repos\/owner(\d+)\/repo\d+\/pulls\/(\d+)$/.exec(
    url.pathname,
  );
  if (detail)
    return json(
      prs.find(
        (item) => item.id === Number(detail[1]) * 100 + Number(detail[2]),
      ) ?? {},
      prs.some(
        (item) => item.id === Number(detail[1]) * 100 + Number(detail[2]),
      )
        ? 200
        : 404,
    );
  if (/^\/repos\/owner\d+\/repo\d+\/pulls$/.test(url.pathname))
    return json(
      prs.filter((item) =>
        url.pathname.includes(`owner${item.id < 200 ? 1 : 2}/`),
      ),
    );
  throw new Error(`Unexpected test API path: ${url.pathname}`);
});
const app = createApp({
  createDatabase: () => ({ db, close: async () => {} }),
  createAuth: () => auth,
  githubFetch: fetcher,
});

async function identity(id: string) {
  await db
    .insert(schema.user)
    .values({ id, name: id, email: `${id}@example.com`, emailVerified: true });
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession(id);
  return `better-auth.session_token=${encodeURIComponent(`${session.token}.${await makeSignature(session.token, env.BETTER_AUTH_SECRET)}`)}`;
}
async function get(path: string, session: string | undefined = cookie) {
  return app.request(
    `http://localhost:1337/api/v1${path}`,
    {
      headers: {
        ...(session ? { Cookie: session } : {}),
        Origin: env.FRONTEND_URL,
      },
    },
    env,
  );
}

beforeAll(async () => {
  await storage.exec(
    await readFile(
      new NodeURL("../drizzle/0000_free_supernaut.sql", import.meta.url),
      "utf8",
    ),
  );
  cookie = await identity("github-user");
  otherCookie = await identity("other-user");
  await db.insert(schema.account).values({
    id: "local-account",
    accountId: "123",
    providerId: "github",
    userId: "github-user",
    accessToken: await symmetricEncrypt({
      key: env.BETTER_AUTH_SECRET,
      data: "backend-only-token",
    }),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});
beforeEach(() => {
  mode = "normal";
  fetcher.mockClear();
});
afterAll(async () => {
  await storage.close();
});

describe("GitHub frontend API", () => {
  it("requires the Better Auth cookie on every endpoint and returns a request ID", async () => {
    for (const path of [
      "/github/connection",
      "/repositories",
      "/pull-requests",
      "/dashboard/overview",
      "/repositories/1/pull-requests/1",
      "/repositories/1/pull-requests/1/files",
    ]) {
      const response = await get(path, "");
      expect(response.status).toBe(401);
      const body = (await response.json()) as {
        error: { code: string; requestId: string };
      };
      expect(body.error.code).toBe("SESSION_REQUIRED");
      expect(body.error.requestId).toBe(response.headers.get("X-Request-ID"));
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns connected account and installation metadata without tokens", async () => {
    const response = await get("/github/connection");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      data: {
        status: "connected",
        account: { id: "123", login: "octocat" },
        installations: [{ id: "10", repositorySelection: "selected" }],
        lastSyncedAt: null,
      },
    });
    expect(text).not.toContain("backend-only-token");
    expect(text).not.toContain("accessToken");
  });

  it("separates disconnected, installation-required and reauthorization states", async () => {
    expect(
      await (await get("/github/connection", otherCookie)).json(),
    ).toMatchObject({ data: { status: "disconnected" } });
    mode = "no-installations";
    expect(await (await get("/github/connection")).json()).toMatchObject({
      data: {
        status: "installation_required",
        installUrl: "http://localhost:1337/api/v1/github/install",
      },
    });
    expect((await get("/repositories")).status).toBe(403);
    mode = "expired";
    expect(await (await get("/github/connection")).json()).toMatchObject({
      data: { status: "reauthorization_required" },
    });
    expect(await (await get("/repositories")).json()).toMatchObject({
      error: { code: "GITHUB_REAUTH_REQUIRED" },
    });
  });

  it("lists repositories with filters and opaque continuation", async () => {
    const first = (await (await get("/repositories?limit=1")).json()) as {
      data: { id: string }[];
      pagination: { nextCursor: string; hasMore: boolean };
    };
    expect(first.data[0].id).toBe("1");
    expect(first.pagination.hasMore).toBe(true);
    const second = await (
      await get(
        `/repositories?limit=1&cursor=${encodeURIComponent(first.pagination.nextCursor)}`,
      )
    ).json();
    expect(second).toMatchObject({
      data: [{ id: "2", archived: true }],
      pagination: { hasMore: false, nextCursor: null },
    });
    expect(
      await (await get("/repositories?archived=false&search=repo1")).json(),
    ).toMatchObject({ data: [{ id: "1" }] });
    expect(
      (
        await get(
          `/repositories?archived=true&cursor=${encodeURIComponent(first.pagination.nextCursor)}`,
        )
      ).status,
    ).toBe(400);
  });

  it("does not accept inaccessible installation or repository IDs", async () => {
    expect((await get("/repositories?installationId=999")).status).toBe(404);
    expect((await get("/pull-requests?repositoryId=999")).status).toBe(404);
    expect((await get("/repositories/999/pull-requests/1")).status).toBe(404);
    expect(
      fetcher.mock.calls.some(([url]) =>
        String(url).includes("/repos/owner999/"),
      ),
    ).toBe(false);
  });

  it("paginates the combined result in global order without repeating repo page one", async () => {
    const first = (await (
      await get("/pull-requests?state=all&limit=1")
    ).json()) as { data: { id: string }[]; pagination: { nextCursor: string } };
    expect(first.data.map((item) => item.id)).toEqual(["101"]);
    const second = (await (
      await get(
        `/pull-requests?state=all&limit=1&cursor=${encodeURIComponent(first.pagination.nextCursor)}`,
      )
    ).json()) as {
      data: { id: string; state: string; appReview: unknown }[];
      pagination: { nextCursor: string };
    };
    expect(second.data).toMatchObject([
      { id: "202", state: "merged", appReview: null },
    ]);
    const third = await (
      await get(
        `/pull-requests?state=all&limit=1&cursor=${encodeURIComponent(second.pagination.nextCursor)}`,
      )
    ).json();
    expect(third).toMatchObject({
      data: [{ id: "103" }],
      pagination: { hasMore: false },
    });
  });

  it("revalidates access when following a previously issued cursor", async () => {
    const first = (await (
      await get("/pull-requests?state=all&limit=1")
    ).json()) as { pagination: { nextCursor: string } };
    mode = "revoked";
    expect(
      (
        await get(
          `/pull-requests?state=all&limit=1&cursor=${encodeURIComponent(first.pagination.nextCursor)}`,
        )
      ).status,
    ).toBe(400);
    expect((await get("/repositories/1/pull-requests/1")).status).toBe(404);
  });

  it("filters repository PRs, normalizes merged state and never returns issue counts", async () => {
    expect(
      await (await get("/pull-requests?repositoryId=2&state=merged")).json(),
    ).toMatchObject({ data: [{ state: "merged", appReview: null }] });
    expect(
      await (await get("/pull-requests?repositoryId=2&state=closed")).json(),
    ).toMatchObject({ data: [] });
    const response = await get("/dashboard/overview");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        repositoryCount: 2,
        openPullRequestCount: 2,
        reviewMetrics: null,
        lastSyncedAt: null,
      },
    });
  });

  it("returns detail and nullable patches without claiming complete diffs", async () => {
    expect(
      await (await get("/repositories/1/pull-requests/1")).json(),
    ).toMatchObject({
      data: {
        body: null,
        additions: 4,
        deletions: 2,
        changedFiles: 1,
        mergeable: null,
      },
    });
    expect(
      await (await get("/repositories/1/pull-requests/1/files")).json(),
    ).toMatchObject({
      data: [{ filename: "binary.png", previousFilename: null, patch: null }],
    });
  });

  it("returns null rather than a fabricated count when GitHub count results are incomplete", async () => {
    mode = "count-incomplete";
    const response = await get("/dashboard/overview");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        repositoryCount: 2,
        openPullRequestCount: null,
        reviewMetrics: null,
      },
    });
  });

  it("validates filters, repeated parameters and tampered cursors", async () => {
    for (const path of [
      "/repositories?limit=10000",
      "/repositories?archived=maybe",
      "/pull-requests?state=fake",
      "/pull-requests?limit=1&limit=2",
      "/repositories?cursor=tampered",
    ]) {
      expect((await get(path)).status).toBe(400);
    }
  });

  it("returns sanitized upstream failures and propagates Retry-After", async () => {
    mode = "rate-limit";
    const limited = await get("/repositories");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("37");
    expect(await limited.json()).toMatchObject({
      error: { code: "GITHUB_RATE_LIMITED" },
    });
    mode = "unavailable";
    const failed = await get("/repositories");
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain("private upstream");
    mode = "incomplete";
    expect((await get("/pull-requests")).status).toBe(502);
  });

  it("binds install state to the session and browser and checks the returned installation", async () => {
    const start = await get("/github/install");
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("Location")!);
    expect(location.origin).toBe("https://github.com");
    const state = location.searchParams.get("state")!;
    const nonceCookie = start.headers.get("Set-Cookie")!.split(";")[0];
    const path = `/github/install/callback?installation_id=10&state=${encodeURIComponent(state)}`;
    expect((await get(path)).status).toBe(400);
    expect((await get(path, `${otherCookie}; ${nonceCookie}`)).status).toBe(
      403,
    );
    const complete = await get(path, `${cookie}; ${nonceCookie}`);
    expect(complete.status).toBe(302);
    expect(complete.headers.get("Location")).toBe(
      "http://localhost:5173/dashboard?github=connected",
    );
    expect(complete.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("rejects expired GitHub access tokens when no refresh token is available", async () => {
    await db
      .update(schema.account)
      .set({ accessTokenExpiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.account.id, "local-account"));
    try {
      expect(await (await get("/repositories")).json()).toMatchObject({
        error: { code: "GITHUB_REAUTH_REQUIRED" },
      });
    } finally {
      await db
        .update(schema.account)
        .set({ accessTokenExpiresAt: null })
        .where(eq(schema.account.id, "local-account"));
    }
  });

  it("refreshes expiring tokens via Better Auth and stores refreshed tokens encrypted", async () => {
    await db
      .update(schema.account)
      .set({
        accessTokenExpiresAt: new Date(Date.now() - 60_000),
        refreshToken: await symmetricEncrypt({
          key: env.BETTER_AUTH_SECRET,
          data: "backend-refresh-token",
        }),
      })
      .where(eq(schema.account.id, "local-account"));
    const refresh = vi.fn<typeof fetch>(async () =>
      json({
        access_token: "backend-only-token",
        refresh_token: "rotated-backend-refresh-token",
        expires_in: 3600,
        refresh_token_expires_in: 86400,
        token_type: "bearer",
      }),
    );
    vi.stubGlobal("fetch", refresh);
    try {
      expect((await get("/repositories")).status).toBe(200);
      expect(refresh).toHaveBeenCalledOnce();
      const [stored] = await db
        .select()
        .from(schema.account)
        .where(eq(schema.account.id, "local-account"));
      expect(stored.accessToken).not.toBe("backend-only-token");
      expect(
        await symmetricDecrypt({
          key: env.BETTER_AUTH_SECRET,
          data: stored.refreshToken!,
        }),
      ).toBe("rotated-backend-refresh-token");
    } finally {
      vi.unstubAllGlobals();
      await db
        .update(schema.account)
        .set({
          accessTokenExpiresAt: null,
          refreshToken: null,
          refreshTokenExpiresAt: null,
        })
        .where(eq(schema.account.id, "local-account"));
    }
  });
});

describe("opaque pagination", () => {
  it("rejects expired cursors", async () => {
    const tokens = new OpaqueTokens(env.BETTER_AUTH_SECRET, "user");
    const token = await tokens.seal("repos", { page: 1 });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    try {
      await expect(
        tokens.open("repos", token, z.object({ page: z.number() })),
      ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects cross-user and cross-purpose tokens", async () => {
    const one = new OpaqueTokens(env.BETTER_AUTH_SECRET, "one");
    const two = new OpaqueTokens(env.BETTER_AUTH_SECRET, "two");
    const token = await one.seal("repos", { page: 2 });
    expect(
      await one.open("repos", token, z.object({ page: z.number() })),
    ).toEqual({ page: 2 });
    await expect(
      two.open("repos", token, z.object({ page: z.number() })),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
    await expect(
      one.open("prs", token, z.object({ page: z.number() })),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("merges pages across multiple disjoint GitHub search chunks", async () => {
    const repositories = Array.from({ length: 21 }, (_, index) =>
      repo(index + 1),
    );
    const values = [
      pr(21, 1, "2026-10-24T12:00:00Z"),
      pr(1, 1, "2026-10-23T12:00:00Z"),
      pr(21, 2, "2026-10-22T12:00:00Z"),
    ];
    const mock: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/search/issues") {
        const items = values.filter(
          (item) =>
            url.searchParams
              .get("q")
              ?.includes(
                `repo:owner${Math.floor(item.id / 100)}/repo${Math.floor(item.id / 100)} `,
              ) ||
            url.searchParams
              .get("q")
              ?.endsWith(
                `repo:owner${Math.floor(item.id / 100)}/repo${Math.floor(item.id / 100)}`,
              ),
        );
        return json({
          total_count: items.length,
          incomplete_results: false,
          items: items.map((item) => ({
            id: item.id,
            number: item.number,
            created_at: item.created_at,
            updated_at: item.updated_at,
            repository_url: `https://api.github.com/repos/owner${Math.floor(item.id / 100)}/repo${Math.floor(item.id / 100)}`,
            pull_request: { url: item.html_url },
          })),
        });
      }
      const match = /owner(\d+)\/repo\d+\/pulls\/(\d+)$/.exec(url.pathname)!;
      return json(
        values.find(
          (item) => item.id === Number(match[1]) * 100 + Number(match[2]),
        ),
      );
    };
    const schemas = await import("../src/lib/github/schemas");
    const scoped = repositories.map((item) => ({
      ...schemas.repository.parse(item),
      installationId: "10",
    }));
    const query = {
      state: "all" as const,
      sort: "updated" as const,
      direction: "desc" as const,
      limit: 2,
    };
    const first = await new GitHubService(
      "test",
      env.BETTER_AUTH_SECRET,
      "user",
      mock,
    ).combinedPulls(scoped, query);
    expect(first.data.map((item) => item.id)).toEqual(["2101", "101"]);
    expect(first.pagination.hasMore).toBe(true);
    const second = await new GitHubService(
      "test",
      env.BETTER_AUTH_SECRET,
      "user",
      mock,
    ).combinedPulls(scoped, { ...query, cursor: first.pagination.nextCursor! });
    expect(second.data.map((item) => item.id)).toEqual(["2102"]);
    expect(second.pagination.hasMore).toBe(false);
  });
});

describe("bounded live GitHub work", () => {
  it("returns an empty filtered page with a continuation instead of scanning all repositories", async () => {
    const mock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/user/installations")
        return json({ total_count: 1, installations: [installation(10)] });
      const page = Number(url.searchParams.get("page"));
      return json(
        {
          total_count: 601,
          repositories: [{ ...repo(page), archived: page !== 7 }],
        },
        200,
        page < 7
          ? {
              Link: `<https://api.github.com/repositories?page=${page + 1}>; rel="next"`,
            }
          : undefined,
      );
    });
    const first = await new GitHubService(
      "test",
      env.BETTER_AUTH_SECRET,
      "user",
      mock,
    ).repositories({ limit: 30, archived: false });
    expect(first.data).toEqual([]);
    expect(first.pagination.hasMore).toBe(true);
    expect(mock).toHaveBeenCalledTimes(7);
    const second = await new GitHubService(
      "test",
      env.BETTER_AUTH_SECRET,
      "user",
      mock,
    ).repositories({
      limit: 30,
      archived: false,
      cursor: first.pagination.nextCursor!,
    });
    expect(second.data).toMatchObject([{ id: "7" }]);
    expect(second.pagination.hasMore).toBe(false);
  });

  it("fails explicitly when the complete combined inventory exceeds its safe bound", async () => {
    const mock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/user/installations")
        return json({ total_count: 1, installations: [installation(10)] });
      const page = Number(url.searchParams.get("page"));
      return json(
        {
          total_count: 201,
          repositories: Array.from({ length: page < 3 ? 100 : 1 }, (_, index) =>
            repo((page - 1) * 100 + index + 1),
          ),
        },
        200,
        page < 3
          ? {
              Link: `<https://api.github.com/repositories?page=${page + 1}>; rel="next"`,
            }
          : undefined,
      );
    });
    await expect(
      new GitHubService(
        "test",
        env.BETTER_AUTH_SECRET,
        "user",
        mock,
      ).inventory(),
    ).rejects.toMatchObject({ code: "GITHUB_QUERY_TOO_LARGE" });
    expect(mock).toHaveBeenCalledTimes(4);
  });

  it("reports the GitHub search ceiling rather than silently ending a combined list", async () => {
    const schemas = await import("../src/lib/github/schemas");
    const repositories = [
      { ...schemas.repository.parse(repo(1)), installationId: "10" },
    ];
    const query = {
      state: "all" as const,
      sort: "updated" as const,
      direction: "desc" as const,
      limit: 30,
    };
    const tokens = new OpaqueTokens(env.BETTER_AUTH_SECRET, "user");
    const cursor = await tokens.seal("combined-pulls", {
      filter: await fingerprint({
        state: query.state,
        draft: undefined,
        sort: query.sort,
        direction: query.direction,
      }),
      scope: await fingerprint(
        repositories.map((item) => [
          item.id,
          item.full_name,
          item.installationId,
        ]),
      ),
      offsets: [1000],
    });
    const mock: typeof fetch = async () =>
      json({ total_count: 1001, incomplete_results: false, items: [] });
    await expect(
      new GitHubService(
        "test",
        env.BETTER_AUTH_SECRET,
        "user",
        mock,
      ).combinedPulls(repositories, { ...query, cursor }),
    ).rejects.toMatchObject({ code: "GITHUB_SEARCH_LIMIT", status: 422 });
  });
});
