import { readFile, readdir } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq } from "drizzle-orm";
import { makeSignature, symmetricEncrypt } from "better-auth/crypto";
import * as authSchema from "../src/db/auth-schema";
import * as tables from "../src/db/schema";
import { createApp } from "../src";
import { createAuth } from "../src/lib/auth";
import { readConfig } from "../src/config/env";
import { dispatchPending, processReview } from "../src/lib/reviews/jobs";
import { addedLines } from "../src/lib/reviews/github";
import { generateReview, boundedJson } from "../src/lib/reviews/model";
import type { Bindings } from "../src/types/env";
import { memoryGitHubCache } from "./helpers/github-cache";
import { hasReviewCredentials, reviewConfig } from "../src/lib/reviews/config";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs1" })
  .toString();
const queue = { send: vi.fn(async (_message: { runId: string }) => {}) };
const env: Bindings = {
  ENVIRONMENT: "local",
  BETTER_AUTH_URL: "http://localhost:1337",
  FRONTEND_URL: "http://localhost:5173",
  BETTER_AUTH_SECRET: "review-tests-only-secret-1234567890123456789",
  GITHUB_CLIENT_ID: "test",
  GITHUB_CLIENT_SECRET: "test",
  GITHUB_WEBHOOK_SECRET: "webhook-test-secret",
  GITHUB_APP_SLUG: "openreview-test",
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: privateKey,
  OPEN_AI_KEY: "test-openai-key",
  REVIEW_QUEUE: queue,
};
const config = readConfig(env);
const storage = new PGlite();
const db = drizzle(storage, { schema: authSchema });
const auth = createAuth(config, db);
let cookie = "";
let mode = "normal";
let admin = true;
let eyesActive = false;
let published: {
  id: number;
  html_url: string;
  body: string;
  commit_id: string;
  user: { login: string; type: string };
}[] = [];
const sha = "a".repeat(40);
const user = {
  id: 123,
  login: "owner",
  avatar_url: null,
  html_url: "https://github.com/owner",
};
const repo = () => ({
  id: 1,
  name: "repo",
  full_name: "owner/repo",
  owner: user,
  description: null,
  html_url: "https://github.com/owner/repo",
  private: true,
  default_branch: "main",
  language: "TypeScript",
  archived: false,
  updated_at: "2026-10-24T00:00:00Z",
  permissions: { pull: true, push: admin, admin },
});
const pr = () => ({
  id: 101,
  number: 1,
  title: "Change",
  html_url: "https://github.com/owner/repo/pull/1",
  state: "open",
  draft: mode === "draft",
  user,
  head: { ref: "feature", sha: mode === "superseded" ? "b".repeat(40) : sha },
  base: { ref: "main", sha: "c".repeat(40) },
  labels: [],
  created_at: "2026-10-24T00:00:00Z",
  updated_at: "2026-10-24T00:00:00Z",
  closed_at: null,
  merged_at: null,
  body: null,
  changed_files: 1,
});
const json = (value: unknown, status = 200) => Response.json(value, { status });
const remote = vi.fn<typeof fetch>(async (input, init) => {
  const url = new URL(String(input));
  if (url.origin === "https://api.openai.com") {
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer test-openai-key",
    );
    const body = JSON.parse(String(init?.body));
    expect(body.store).toBe(false);
    expect(body.input).not.toContain("test-openai-key");
    expect(body.input).not.toContain("SHOULD_NOT_BE_SENT");
    if (mode === "ai-failed") return json({}, 429);
    if (mode === "push-during-ai") mode = "superseded";
    if (mode === "lease-lost")
      await db.update(tables.reviewRun).set({ leaseToken: "another-worker" });
    return json({
      status: "completed",
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                summary:
                  mode === "no-findings"
                    ? "Adds input checks."
                    : "An actionable issue was found.",
                findings:
                  mode === "no-findings"
                    ? []
                    : [
                        {
                          path: "src/file.ts",
                          line: mode === "invalid-line" ? 999 : 2,
                          severity: "high",
                          title: "Unvalidated input",
                          description: "Validate this input before use.",
                          suggestion:
                            mode === "multiline-fix"
                              ? "validate();\nunsafe();"
                              : mode === "fenced-fix"
                                ? "```"
                                : "validate();",
                        },
                      ],
              }),
            },
          ],
        },
      ],
    });
  }
  if (url.pathname === "/app/installations/10")
    return json({
      id: 10,
      suspended_at: mode === "suspended" ? "2026-10-24T00:00:00Z" : null,
    });
  if (url.pathname === "/app/installations/10/access_tokens")
    return json({ token: "installation-token" });
  if (url.pathname === "/user/installations")
    return json({
      total_count: 1,
      installations: [
        {
          id: 10,
          account: { login: "owner", type: "User" },
          repository_selection: "all",
          suspended_at: null,
        },
      ],
    });
  if (url.pathname === "/user/installations/10/repositories")
    return json({ total_count: 1, repositories: [repo()] });
  if (url.pathname === "/repos/owner/repo")
    return mode === "revoked" ? json({}, 404) : json(repo());
  if (url.pathname === "/repos/owner/repo/pulls/1") return json(pr());
  if (url.pathname === "/repos/owner/repo/issues/1/reactions") {
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ content: "eyes" });
    if (mode === "reaction-failed") return json({}, 403);
    eyesActive = true;
    return json({ id: 777 }, 201);
  }
  if (url.pathname === "/repos/owner/repo/issues/1/reactions/777") {
    expect(init?.method).toBe("DELETE");
    if (mode === "reaction-remove-failed") return json({}, 403);
    eyesActive = false;
    return new Response(null, { status: 204 });
  }
  if (url.pathname === "/search/issues")
    return json({
      total_count: 1,
      incomplete_results: false,
      items: [
        {
          id: 101,
          number: 1,
          repository_url: "https://api.github.com/repos/owner/repo",
          created_at: pr().created_at,
          updated_at: pr().updated_at,
          pull_request: { url: pr().html_url },
        },
      ],
    });
  if (url.pathname.endsWith("/files"))
    return json([
      {
        filename: "src/file.ts",
        status: "modified",
        patch: "@@ -1 +1,2 @@\n const x = 1;\n+unsafe();",
      },
      ...(mode === "secret-file"
        ? [
            {
              filename: ".envrc",
              status: "added",
              patch: "@@ -0,0 +1 @@\n+KEY=SHOULD_NOT_BE_SENT",
            },
          ]
        : []),
    ]);
  if (url.pathname.includes("/contents/"))
    return json({
      encoding: "base64",
      content: Buffer.from("const x = 1;\nunsafe();").toString("base64"),
      size: 23,
    });
  if (url.pathname.endsWith("/reviews")) {
    if (init?.method !== "POST") return json(published);
    const body = JSON.parse(String(init.body));
    expect(body.event).toBe("COMMENT");
    expect(body.commit_id).toBe(sha);
    expect(body.comments.length).toBe(
      ["invalid-line", "no-findings"].includes(mode) ? 0 : 1,
    );
    const review = {
      id: 555,
      html_url: "https://github.com/owner/repo/pull/1#pullrequestreview-555",
      body: body.body,
      commit_id: sha,
      user: { login: "openreview-test[bot]", type: "Bot" },
    };
    published.push(review);
    if (mode === "ambiguous-post")
      throw new TypeError("network disconnected after publication");
    return json(review);
  }
  throw new Error(`Unexpected mock path ${url.pathname}`);
});
const app = createApp({
  createDatabase: () => ({ db, close: async () => {} }),
  createAuth: () => auth,
  githubFetch: remote,
  githubCache: null,
});
async function api(path: string, body?: unknown, session = cookie) {
  return app.request(
    `http://localhost:1337/api/v1${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Cookie: session,
        Origin: env.FRONTEND_URL,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}
const payload = () => ({
  action: "opened",
  installation: { id: 10 },
  repository: { id: 1, full_name: "owner/repo" },
  pull_request: pr(),
});
async function webhook(
  value: unknown = payload(),
  delivery = crypto.randomUUID(),
  valid = true,
  kind = "pull_request",
) {
  const body = JSON.stringify(value);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = Buffer.from(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  ).toString("hex");
  return app.request(
    "http://localhost:1337/api/v1/webhooks/github",
    {
      method: "POST",
      headers: {
        "X-GitHub-Delivery": delivery,
        "X-GitHub-Event": kind,
        "X-Hub-Signature-256": valid
          ? `sha256=${signature}`
          : `sha256=${"0".repeat(64)}`,
      },
      body,
    },
    env,
  );
}
async function startedRun() {
  const response = await webhook();
  expect(response.status).toBe(202);
  const body = (await response.json()) as { runId: string; ignored: boolean };
  expect(body.ignored).toBe(false);
  return body.runId;
}

beforeAll(async () => {
  for (const file of (await readdir("drizzle"))
    .filter((name) => name.endsWith(".sql"))
    .sort())
    await storage.exec(await readFile(`drizzle/${file}`, "utf8"));
  await db.insert(authSchema.user).values({
    id: "review-user",
    name: "Reviewer",
    email: "review@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const token = "review-test-session";
  await db.insert(authSchema.session).values({
    id: "review-session",
    token,
    userId: "review-user",
    expiresAt: new Date(Date.now() + 86400_000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(authSchema.account).values({
    id: "review-account",
    accountId: "123",
    providerId: "github",
    userId: "review-user",
    accessToken: await symmetricEncrypt({
      key: env.BETTER_AUTH_SECRET,
      data: "user-token",
    }),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${await makeSignature(token, env.BETTER_AUTH_SECRET)}`)}`;
});
beforeEach(async () => {
  mode = "normal";
  admin = true;
  published = [];
  eyesActive = false;
  remote.mockClear();
  queue.send.mockReset();
  await db.delete(tables.reviewDelivery);
  await db.delete(tables.reviewRun);
  await db.delete(tables.reviewRepository);
});
afterAll(() => storage.close());

describe("automatic PR reviews", () => {
  it("reviews repositories by default while keeping signature and session checks", async () => {
    expect((await webhook(payload(), undefined, false)).status).toBe(401);
    expect(queue.send).not.toHaveBeenCalled();
    const response = await webhook();
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ignored: false });
    expect(await db.select().from(tables.reviewRun)).toHaveLength(1);
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(
      await (await api("/repositories/1/reviews/settings")).json(),
    ).toMatchObject({
      data: { enabled: true, available: true, canAdmin: true },
    });
    expect(
      (await api("/repositories/1/reviews/settings", undefined, "")).status,
    ).toBe(401);
    admin = false;
    expect(
      (await api("/repositories/1/reviews/settings", { enabled: false }))
        .status,
    ).toBe(403);
    expect(
      (await api("/repositories/1/pull-requests/1/reviews", {})).status,
    ).toBe(403);
  });
  it("stops automatic reviews when an administrator disables a repository", async () => {
    expect(
      (await api("/repositories/1/reviews/settings", { enabled: false }))
        .status,
    ).toBe(200);
    expect(
      await (await api("/repositories/1/reviews/settings")).json(),
    ).toMatchObject({ data: { enabled: false, available: true } });
    expect(await (await webhook()).json()).toMatchObject({
      ignored: true,
      runId: null,
    });
    expect(await db.select().from(tables.reviewRun)).toHaveLength(0);
    expect(
      (await api("/repositories/1/pull-requests/1/reviews", {})).status,
    ).toBe(409);
  });
  it("stores jobs, generates structured findings and publishes a bot COMMENT review", async () => {
    const runId = await startedRun();
    expect(await processReview(db, config, runId, remote)).toBe("done");
    const [run] = await db
      .select()
      .from(tables.reviewRun)
      .where(eq(tables.reviewRun.id, runId));
    expect(run).toMatchObject({
      status: "completed",
      publicationStatus: "published",
      githubReviewId: "555",
    });
    expect(run.result?.findings).toHaveLength(1);
    expect(published).toHaveLength(1);
    expect(
      await (await api("/repositories/1/pull-requests/1/reviews")).json(),
    ).toMatchObject({
      data: [
        { id: runId, status: "completed", publicationStatus: "published" },
      ],
    });
    remote.mockClear();
    expect(await processReview(db, config, runId, remote)).toBe("done");
    expect(remote).not.toHaveBeenCalled();
  });
  it("adds eyes before analysis and keeps them after publication", async () => {
    const runId = await startedRun();
    expect(await processReview(db, config, runId, remote)).toBe("done");
    const calls = remote.mock.calls;
    const index = (path: string, method: string) =>
      calls.findIndex(
        ([input, init]) =>
          new URL(String(input)).pathname === path && init?.method === method,
      );
    expect(
      index("/repos/owner/repo/issues/1/reactions", "POST"),
    ).toBeGreaterThan(-1);
    expect(index("/repos/owner/repo/issues/1/reactions", "POST")).toBeLessThan(
      index("/repos/owner/repo/pulls/1/files", "GET"),
    );
    expect(index("/repos/owner/repo/issues/1/reactions", "POST")).toBeLessThan(
      index("/v1/responses", "POST"),
    );
    expect(index("/repos/owner/repo/issues/1/reactions/777", "DELETE")).toBe(
      -1,
    );
    expect(eyesActive).toBe(true);
    expect(published[0].body).toContain("## ✅ Review complete");
    expect(published[0].body).toContain(
      "1 issue found. See the inline comment.",
    );
    expect(published[0].body).not.toContain("Unvalidated input");
    expect(published[0].body).toContain("<summary>Review scope</summary>");
  });
  it.each(["reaction-failed", "reaction-remove-failed"])(
    "does not fail a review when progress feedback fails: %s",
    async (value) => {
      const runId = await startedRun();
      mode = value;
      expect(await processReview(db, config, runId, remote)).toBe("done");
      expect(
        (await db.select().from(tables.reviewRun))[0].publicationStatus,
      ).toBe("published");
      if (value === "reaction-failed")
        expect(published[0].body).toContain("Could not add 👀");
      else expect(published[0].body).not.toContain("Could not add 👀");
    },
  );
  it("keeps eyes when model analysis fails", async () => {
    const runId = await startedRun();
    mode = "ai-failed";
    expect(await processReview(db, config, runId, remote)).toBe("retry");
    expect(eyesActive).toBe(true);
    expect(
      remote.mock.calls.some(
        ([input, init]) =>
          String(input).endsWith("/reactions/777") && init?.method === "DELETE",
      ),
    ).toBe(false);
  });
  it.each(["normal", "multiline-fix", "fenced-fix"])(
    "posts concise inline findings with safe suggestions: %s",
    async (value) => {
      const runId = await startedRun();
      mode = value;
      await processReview(db, config, runId, remote);
      const call = remote.mock.calls.find(
        ([input, init]) =>
          new URL(String(input)).pathname.endsWith("/reviews") &&
          init?.method === "POST",
      );
      const body = JSON.parse(String(call?.[1]?.body));
      expect(body.comments[0].body).toContain(
        "🔴 High · **Unvalidated input**",
      );
      expect(
        body.comments[0].body.includes("```suggestion\nvalidate();\n```"),
      ).toBe(value === "normal");
    },
  );
  it("posts a short result when no issues are found", async () => {
    const runId = await startedRun();
    mode = "no-findings";
    expect(await processReview(db, config, runId, remote)).toBe("done");
    expect(published[0].body).toContain("No issues found in reviewed code.");
    expect(published[0].body).not.toContain("See inline comments");
    expect(eyesActive).toBe(true);
  });
  it("preserves eyes while another commit on the same PR is being reviewed", async () => {
    const runId = await startedRun();
    await db.insert(tables.reviewRun).values({
      id: crypto.randomUUID(),
      repositoryId: "1",
      installationId: "10",
      fullName: "owner/repo",
      pullNumber: 1,
      headSha: "b".repeat(40),
      model: config.OPENAI_REVIEW_MODEL,
      status: "reviewing",
      leaseToken: "other-worker",
      leaseUntil: new Date(Date.now() + 60_000),
    });
    expect(await processReview(db, config, runId, remote)).toBe("done");
    expect(eyesActive).toBe(true);
    expect(
      remote.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
  });
  it("deduplicates delivery IDs and commits, and detects reused IDs with a changed payload", async () => {
    const delivery = crypto.randomUUID();
    const first = (await (await webhook(payload(), delivery)).json()) as {
      runId: string;
    };
    expect(await (await webhook(payload(), delivery)).json()).toMatchObject(
      first,
    );
    expect(await db.select().from(tables.reviewRun)).toHaveLength(1);
    expect(
      (await webhook({ ...payload(), action: "synchronize" }, delivery)).status,
    ).toBe(409);
  });
  it("recovers durable jobs after a queue-send failure", async () => {
    queue.send.mockRejectedValueOnce(new Error("queue unavailable"));
    expect((await webhook()).status).toBe(503);
    expect(await dispatchPending(db, queue)).toBe(1);
    expect(queue.send).toHaveBeenCalledTimes(2);
  });
  it("overlays database-fresh review progress on cached GitHub PRs", async () => {
    const runId = await startedRun();
    await processReview(db, config, runId, remote);
    const { store } = memoryGitHubCache();
    const cached = createApp({
      createDatabase: () => ({ db, close: async () => {} }),
      createAuth: () => auth,
      githubFetch: remote,
      githubCache: store,
    });
    const get = () =>
      cached.request(
        "http://localhost:1337/api/v1/dashboard/overview",
        { headers: { Cookie: cookie } },
        env,
      );
    const first = await get();
    expect(await first.json()).toMatchObject({
      data: {
        recentPullRequests: [{ appReview: { id: runId, status: "completed" } }],
        reviewMetrics: { completed: 1, pending: 0 },
      },
    });
    await db
      .update(tables.reviewRun)
      .set({ status: "reviewing" })
      .where(eq(tables.reviewRun.id, runId));
    remote.mockClear();
    const second = await get();
    expect(second.headers.get("X-GitHub-Cache")).toBe("HIT");
    expect(await second.json()).toMatchObject({
      data: {
        recentPullRequests: [{ appReview: { status: "reviewing" } }],
        reviewMetrics: { completed: 0, pending: 1 },
      },
    });
    expect(remote).not.toHaveBeenCalled();
  });
  it("reconciles an ambiguous GitHub POST without generating or posting twice", async () => {
    const runId = await startedRun();
    mode = "ambiguous-post";
    expect(await processReview(db, config, runId, remote)).toBe("retry");
    mode = "normal";
    expect(await processReview(db, config, runId, remote)).toBe("done");
    expect(published).toHaveLength(1);
    expect(
      remote.mock.calls.filter(
        ([input]) => new URL(String(input)).origin === "https://api.openai.com",
      ),
    ).toHaveLength(1);
  });
  it.each(["superseded", "draft", "revoked", "suspended"])(
    "does not call OpenAI or publish for %s PR access/state",
    async (value) => {
      const runId = await startedRun();
      mode = value;
      expect(await processReview(db, config, runId, remote)).toBe("done");
      expect(published).toHaveLength(0);
      expect(
        remote.mock.calls.some(([input]) =>
          String(input).startsWith("https://api.openai.com"),
        ),
      ).toBe(false);
    },
  );
  it("keeps invalid inline locations in the summary only", async () => {
    const runId = await startedRun();
    mode = "invalid-line";
    expect(await processReview(db, config, runId, remote)).toBe("done");
    expect(published[0].body).toContain("no valid added-line anchor");
    expect(published[0].body).toContain("Unvalidated input");
    expect(published[0].body).not.toContain("```suggestion");
  });
  it("excludes secret-file patches from model input and reports partial coverage", async () => {
    const runId = await startedRun();
    mode = "secret-file";
    expect(await processReview(db, config, runId, remote)).toBe("done");
    expect(published[0].body).toContain(
      "Secret/configuration key files were excluded.",
    );
  });
  it("does not publish a result if a newer commit arrives during model analysis", async () => {
    const runId = await startedRun();
    mode = "push-during-ai";
    expect(await processReview(db, config, runId, remote)).toBe("done");
    expect(published).toHaveLength(0);
    expect((await db.select().from(tables.reviewRun))[0]).toMatchObject({
      status: "superseded",
      publicationStatus: "not_requested",
    });
  });
  it("does not publish after losing its database lease during analysis", async () => {
    const runId = await startedRun();
    mode = "lease-lost";
    expect(await processReview(db, config, runId, remote)).toBe("retry");
    expect(published).toHaveLength(0);
    expect((await db.select().from(tables.reviewRun))[0].leaseToken).toBe(
      "another-worker",
    );
  });
  it("ignores draft webhook deliveries without creating a job", async () => {
    mode = "draft";
    expect(await (await webhook()).json()).toMatchObject({ ignored: true });
    expect(await db.select().from(tables.reviewRun)).toHaveLength(0);
    expect(queue.send).not.toHaveBeenCalled();
  });
  it("revives a skipped same-commit job when a draft becomes ready for review", async () => {
    const runId = await startedRun();
    mode = "draft";
    expect(await processReview(db, config, runId, remote)).toBe("done");
    mode = "normal";
    const response = await webhook({
      ...payload(),
      action: "ready_for_review",
    });
    expect(await response.json()).toMatchObject({ runId });
    expect(await processReview(db, config, runId, remote)).toBe("done");
    expect(published).toHaveLength(1);
    expect(await db.select().from(tables.reviewRun)).toHaveLength(1);
  });
  it("retries transient OpenAI failures without posting a fabricated review", async () => {
    const runId = await startedRun();
    mode = "ai-failed";
    expect(await processReview(db, config, runId, remote)).toBe("retry");
    expect(published).toHaveLength(0);
    mode = "normal";
    expect(await processReview(db, config, runId, remote)).toBe("done");
  });
  it("re-disables administrator-managed repositories on signed installation suspension events", async () => {
    const runId = await startedRun();
    // Disable, then re-enable: the repository now carries a saved settings row.
    await api("/repositories/1/reviews/settings", { enabled: false });
    await api("/repositories/1/reviews/settings", { enabled: true });
    expect(
      (
        await webhook(
          { action: "suspend", installation: { id: 10 } },
          undefined,
          true,
          "installation",
        )
      ).status,
    ).toBe(200);
    expect(await processReview(db, config, runId, remote)).toBe("done");
    expect(published).toHaveLength(0);
    expect((await db.select().from(tables.reviewRepository))[0].enabled).toBe(
      false,
    );
  });
  it("marks removed repositories disabled even without a saved settings row", async () => {
    expect(
      (
        await webhook(
          {
            action: "removed",
            installation: { id: 10 },
            repositories_removed: [{ id: 1, full_name: "owner/repo" }],
          },
          undefined,
          true,
          "installation_repositories",
        )
      ).status,
    ).toBe(200);
    expect(await (await webhook()).json()).toMatchObject({
      ignored: true,
      runId: null,
    });
    expect((await db.select().from(tables.reviewRepository))[0].enabled).toBe(
      false,
    );
  });
  it("respects active leases and finalizes exhausted crashed jobs", async () => {
    const runId = await startedRun();
    await db
      .update(tables.reviewRun)
      .set({ leaseUntil: new Date(Date.now() + 60_000) })
      .where(eq(tables.reviewRun.id, runId));
    expect(await processReview(db, config, runId, remote)).toBe("retry");
    await db
      .update(tables.reviewRun)
      .set({ status: "reviewing", attempts: 4, leaseUntil: new Date(0) })
      .where(eq(tables.reviewRun.id, runId));
    expect(await dispatchPending(db, queue)).toBe(0);
    expect((await db.select().from(tables.reviewRun))[0].status).toBe("failed");
  });
});

describe("review safety boundaries", () => {
  it("detects credential readiness without a global enable switch", () => {
    expect(hasReviewCredentials(config)).toBe(true);
    expect(reviewConfig(config).apiKey).toBe("test-openai-key");
    const missingKey = {
      ...config,
      OPENAI_API_KEY: undefined,
      OPEN_AI_KEY: undefined,
    };
    expect(hasReviewCredentials(missingKey)).toBe(false);
    expect(() => reviewConfig(missingKey)).toThrow(
      "credentials are not fully configured",
    );
  });
  it("maps only added new-side diff lines", () => {
    expect([
      ...addedLines("@@ -10,2 +10,3 @@\n context\n-old\n+new\n+second"),
    ]).toEqual([11, 12]);
  });
  it("rejects oversized upstream JSON and invalid model responses", async () => {
    await expect(
      boundedJson(new Response("x".repeat(100)), 10),
    ).rejects.toMatchObject({ code: "UPSTREAM_RESPONSE_TOO_LARGE" });
    await expect(
      generateReview("key", "model", {}, async () =>
        json({ status: "incomplete", output: [] }),
      ),
    ).rejects.toMatchObject({ code: "OPENAI_INCOMPLETE_RESPONSE" });
  });
});
