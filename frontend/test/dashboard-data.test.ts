import { createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDashboardData } from "../src/lib/dashboard-data";

// Node normally resolves Solid's server entry, where effects deliberately do not run.
vi.mock("solid-js", () => import("solid-js/dist/solid.js"));

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose());
});

function setup(path: string) {
  const events = new EventTarget();
  const pushState = vi.fn();
  vi.stubGlobal("window", {
    location: { pathname: path, search: "" },
    history: { pushState },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    setTimeout,
    clearTimeout,
  });
  const calls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      const url = new URL(path);
      calls.push(url);
      const data = url.pathname.endsWith("connection")
        ? {
            status: "connected",
            account: null,
            installations: [],
            installUrl: null,
            lastSyncedAt: null,
          }
        : url.pathname.endsWith("overview")
          ? {
              repositoryCount: null,
              openPullRequestCount: 0,
              recentPullRequests: [],
              reviewMetrics: null,
              lastSyncedAt: null,
            }
          : url.pathname.endsWith("pull-requests")
            ? [{ id: url.searchParams.has("cursor") ? "second" : "first" }]
            : [{ id: "repo", fullName: "test/repo" }];
      return Response.json({
        data,
        pagination: {
          nextCursor:
            url.pathname.endsWith("pull-requests") &&
            !url.searchParams.has("cursor")
              ? "next"
              : null,
          hasMore:
            url.pathname.endsWith("pull-requests") &&
            !url.searchParams.has("cursor"),
        },
      });
    }),
  );
  const [userId, setUserId] = createSignal("user-a");
  const [signingOut, setSigningOut] = createSignal(false);
  let model!: ReturnType<typeof createDashboardData>;
  createRoot((dispose) => {
    cleanups.push(dispose);
    model = createDashboardData({
      userId,
      signingOut,
      onSessionRequired: vi.fn(),
    });
  });
  const count = (suffix: string) =>
    calls.filter((url) => url.pathname.endsWith(suffix)).length;
  return { model, calls, count, pushState, setUserId, setSigningOut };
}

describe("dashboard request lifecycle", () => {
  it.each(["settings", "models", "review-rules"])(
    "does not fetch repositories on a direct %s visit",
    async (view) => {
      const { model, count } = setup(`/dashboard/${view}`);
      await vi.waitFor(() =>
        expect(model.connection.metadata()?.status).toBe("connected"),
      );
      expect(count("repositories")).toBe(0);
      expect(count("overview")).toBe(0);
      expect(count("pull-requests")).toBe(0);
    },
  );

  it("reuses overview, repository lists and loaded PR pages across view changes", async () => {
    const { model, count } = setup("/dashboard");
    await vi.waitFor(() => expect(model.overview.value()).toBeDefined());
    model.navigate("pull-requests");
    await vi.waitFor(() => expect(model.pulls.items()).toHaveLength(1));
    await model.pulls.more();
    model.navigate("settings");
    model.navigate("overview");
    model.navigate("pull-requests");
    expect(model.pulls.items()).toHaveLength(2);
    expect(count("overview")).toBe(1);
    expect(count("repositories")).toBe(1);
    expect(count("pull-requests")).toBe(2);
    model.setState("merged");
    await vi.waitFor(() => expect(count("pull-requests")).toBe(3));
    await vi.waitFor(() => expect(model.pulls.items()).toHaveLength(1));
  });

  it("batches repository selection with PR navigation and avoids duplicate history", async () => {
    const { model, calls, count, pushState } = setup("/dashboard");
    await vi.waitFor(() => expect(model.overview.value()).toBeDefined());
    model.openRepositoryPulls("repo");
    await vi.waitFor(() => expect(model.pulls.items()).toHaveLength(1));
    expect(count("overview")).toBe(1);
    expect(
      calls
        .find((url) => url.pathname.endsWith("pull-requests"))
        ?.searchParams.get("repositoryId"),
    ).toBe("repo");
    model.navigate("pull-requests");
    expect(pushState).toHaveBeenCalledTimes(1);
  });

  it("clears private state on sign-out and refetches for another user", async () => {
    const { model, count, setSigningOut, setUserId } = setup("/dashboard");
    await vi.waitFor(() => expect(model.overview.value()).toBeDefined());
    setSigningOut(true);
    expect(model.overview.value()).toBeUndefined();
    expect(model.repositories.items()).toEqual([]);
    setUserId("user-b");
    setSigningOut(false);
    await vi.waitFor(() => expect(model.overview.value()).toBeDefined());
    expect(count("overview")).toBe(2);
    expect(count("repositories")).toBe(2);
  });

  it("explicit refresh invalidates retained results", async () => {
    const { model, count } = setup("/dashboard");
    await vi.waitFor(() => expect(model.overview.value()).toBeDefined());
    await model.refresh();
    await vi.waitFor(() => expect(model.overview.value()).toBeDefined());
    expect(count("overview")).toBe(2);
    expect(count("repositories")).toBe(2);
  });
});
