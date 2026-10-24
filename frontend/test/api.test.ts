import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_URL,
  ApiError,
  apiFetch,
  createApiClient,
  retryAfterTimestamp,
} from "../src/lib/api";
import { createGitHubApi, queryString } from "../src/lib/github-api";
import { formatCount, formatTimestamp } from "../src/lib/format";
import { oauthErrorMessage, safeOAuthErrorCode } from "../src/lib/oauth-errors";

afterEach(() => vi.useRealTimers());

describe("credentialed API transport", () => {
  it("bypasses each section's backend cache once after an explicit refresh", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [] }),
    );
    vi.stubGlobal("fetch", fetcher);
    const api = createGitHubApi(vi.fn());
    const signal = new AbortController().signal;
    api.refresh();
    await api.connection(undefined, signal);
    await api.repositories({}, undefined, signal);
    await api.overview(undefined, signal);
    await api.overview(undefined, signal);
    const urls = fetcher.mock.calls.map((call) => new URL(String(call[0])));
    expect(
      urls
        .slice(0, 3)
        .every((url) => url.searchParams.get("refresh") === "true"),
    ).toBe(true);
    expect(urls[3].searchParams.has("refresh")).toBe(false);
  });
  it("always includes cookies, even if a caller requests omission", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetcher);
    await apiFetch("/api/v1/me", { credentials: "omit" });
    expect(fetcher).toHaveBeenCalledWith(
      `${API_URL}/api/v1/me`,
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it.each([
    [401, "SESSION_REQUIRED"],
    [403, "GITHUB_REAUTH_REQUIRED"],
    [403, "GITHUB_INSTALLATION_REQUIRED"],
    [403, "GITHUB_PERMISSION_REQUIRED"],
    [404, "RESOURCE_NOT_FOUND"],
    [502, "GITHUB_INCOMPLETE_RESULTS"],
    [503, "GITHUB_QUERY_TOO_LARGE"],
    [422, "GITHUB_SEARCH_LIMIT"],
    [503, "REVIEWS_NOT_CONFIGURED"],
    [503, "REVIEW_QUEUE_UNAVAILABLE"],
    [409, "REVIEWS_NOT_ENABLED"],
    [403, "REVIEW_ADMIN_REQUIRED"],
    [403, "REVIEW_WRITE_REQUIRED"],
    [409, "PR_NOT_REVIEWABLE"],
  ])(
    "preserves %s/%s without exposing raw provider messages",
    async (status, code) => {
      const callback = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          Response.json(
            {
              error: {
                code,
                message: "sensitive upstream payload",
                requestId: "request-123",
              },
            },
            { status },
          ),
        ),
      );
      const error = await createApiClient(callback)(
        "/api/v1/repositories",
      ).catch((failure) => failure as ApiError);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status, code, requestId: "request-123" });
      expect(error.message).not.toContain("sensitive");
      expect(callback).toHaveBeenCalledWith(error);
    },
  );

  it("respects Retry-After across requests, without automatic retries", async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { error: { code: "GITHUB_RATE_LIMITED" } },
          { status: 429, headers: { "Retry-After": "30" } },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const request = createApiClient();
    await expect(request("/api/v1/repositories")).rejects.toMatchObject({
      retryAt: Date.now() + 30_000,
    });
    await expect(request("/api/v1/pull-requests")).rejects.toMatchObject({
      code: "GITHUB_RATE_LIMITED",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    fetcher.mockResolvedValueOnce(Response.json({ data: [] }));
    await request("/api/v1/repositories");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("handles HTTP-date Retry-After and uses a safe fallback", () => {
    const now = Date.parse("2026-10-23T12:00:00Z");
    expect(retryAfterTimestamp("Fri, 23 Oct 2026 12:01:00 GMT", now)).toBe(
      now + 60_000,
    );
    expect(retryAfterTimestamp(null, now)).toBe(now + 60_000);
  });

  it("rejects malformed success data instead of inventing values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ wrong: [] })),
    );
    await expect(
      createApiClient()("/api/v1/repositories"),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("preserves opaque cursors and filters when serializing", () => {
    const cursor = "opaque+/=token &more";
    const query = queryString({
      cursor,
      draft: "false",
      repositoryId: "123",
      missing: undefined,
    });
    expect(new URLSearchParams(query).get("cursor")).toBe(cursor);
    expect(new URLSearchParams(query).get("draft")).toBe("false");
    expect(new URLSearchParams(query).has("missing")).toBe(false);
  });

  it.each([
    "connected",
    "disconnected",
    "installation_required",
    "reauthorization_required",
  ])("accepts HTTP 200 connection state %s", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          data: {
            status,
            account: null,
            installations: [],
            installUrl: null,
            lastSyncedAt: null,
          },
          pagination: { nextCursor: null, hasMore: false },
        }),
      ),
    );
    const result = await createGitHubApi(vi.fn()).connection(
      undefined,
      new AbortController().signal,
    );
    expect(result.data.status).toBe(status);
  });
});

describe("display and OAuth errors", () => {
  it("distinguishes unknown counts from zero", () => {
    expect(formatCount(null)).toBe("—");
    expect(formatCount(undefined)).toBe("—");
    expect(formatCount(0)).toBe("0");
  });
  it("does not invent missing dates", () => {
    expect(formatTimestamp(null)).toBe("Date unavailable");
    expect(formatTimestamp("invalid")).toBe("Date unavailable");
  });
  it("explains cancellation, state expiry and email permissions separately", () => {
    expect(oauthErrorMessage("access_denied")).toContain("cancelled");
    expect(oauthErrorMessage("state_mismatch")).toContain("expired");
    expect(oauthErrorMessage("email_not_found")).toContain("email");
    expect(oauthErrorMessage("code=secret-cookie-token")).not.toContain(
      "secret",
    );
    expect(oauthErrorMessage(null)).toBe("");
    expect(safeOAuthErrorCode("ACCESS_DENIED")).toBe("access_denied");
    expect(safeOAuthErrorCode("code=secret-cookie-token")).toBe("oauth_error");
  });
});
