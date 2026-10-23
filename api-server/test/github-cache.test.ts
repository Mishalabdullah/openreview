import { describe, expect, it, vi } from "vitest";
import { GitHubCache } from "../src/lib/github/cache";
import { memoryGitHubCache } from "./helpers/github-cache";

describe("private GitHub cache", () => {
  const secret = "cache-tests-only-secret";
  const origin = "https://api.example.com";

  it("encrypts cached data and keeps credentials and identifiers out of cache keys", async () => {
    const { store, entries } = memoryGitHubCache();
    const cache = new GitHubCache(
      store,
      secret,
      origin,
      "private-user",
      "account",
      "private-token",
    );
    await cache.write(
      "api:/repositories",
      JSON.stringify({ repository: "private-repository" }),
    );
    expect(await cache.read("api:/repositories")).toMatchObject({
      body: '{"repository":"private-repository"}',
      age: 0,
    });
    const [key, response] = [...entries][0];
    expect(key).not.toContain("private-user");
    expect(key).not.toContain("private-token");
    expect(await response.text()).not.toContain("private-repository");
  });

  it("isolates users, linked accounts, credentials, origins, secrets and resources", async () => {
    const { store } = memoryGitHubCache();
    await new GitHubCache(
      store,
      secret,
      origin,
      "one",
      "account",
      "token",
    ).write("api:/repositories", "{}");
    for (const args of [
      [secret, origin, "two", "account", "token"],
      [secret, origin, "one", "other-account", "token"],
      [secret, origin, "one", "account", "new-token"],
      [secret, "https://other.example.com", "one", "account", "token"],
      ["new-secret", origin, "one", "account", "token"],
    ] as const) {
      expect(
        await new GitHubCache(
          store,
          args[0],
          args[1],
          args[2],
          args[3],
          args[4],
        ).read("api:/repositories"),
      ).toBeNull();
    }
    expect(
      await new GitHubCache(
        store,
        secret,
        origin,
        "one",
        "account",
        "token",
      ).read("api:/dashboard/overview"),
    ).toBeNull();
  });

  it("expires within 30 seconds and never extends metadata lifetime in derived responses", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-24T00:00:00Z"));
      const { store } = memoryGitHubCache();
      const cache = () =>
        new GitHubCache(store, secret, origin, "user", "account", "token");
      await cache().write("upstream:repositories", "{}");
      vi.setSystemTime(Date.now() + 20_000);
      const derived = cache();
      expect(await derived.read("upstream:repositories")).toMatchObject({
        age: 20,
      });
      await derived.write("api:overview", "{}");
      vi.setSystemTime(Date.now() + 10_000);
      expect(await cache().read("upstream:repositories")).toBeNull();
      expect(await cache().read("api:overview")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports bypass with cache replacement, without reading stale entries", async () => {
    const { store } = memoryGitHubCache();
    const cache = new GitHubCache(
      store,
      secret,
      origin,
      "user",
      "account",
      "token",
    );
    await cache.write("resource", "old");
    const bypass = new GitHubCache(
      store,
      secret,
      origin,
      "user",
      "account",
      "token",
      true,
    );
    expect(await bypass.read("resource")).toBeNull();
    await bypass.write("resource", "fresh");
    expect(await cache.read("resource")).toMatchObject({ body: "fresh" });
  });

  it("fails open on cache outages, tampering and oversize bodies", async () => {
    const { store, entries } = memoryGitHubCache();
    const cache = new GitHubCache(
      store,
      secret,
      origin,
      "user",
      "account",
      "token",
    );
    await cache.write("large", "x".repeat(1024 * 1024 + 1));
    expect(entries.size).toBe(0);
    await cache.write("resource", "{}");
    const key = [...entries.keys()][0];
    entries.set(key, new Response("tampered"));
    expect(await cache.read("resource")).toBeNull();
    const broken = new GitHubCache(
      {
        match: async () => {
          throw new Error("unavailable");
        },
        put: async () => {
          throw new Error("unavailable");
        },
      },
      secret,
      origin,
      "user",
      "account",
      "token",
    );
    expect(await broken.read("resource")).toBeNull();
    await expect(broken.write("resource", "{}")).resolves.toBeUndefined();
  });
});
