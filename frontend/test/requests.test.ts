import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/lib/api";
import { createLatestRequest, createPagedList } from "../src/lib/requests";

const page = (ids: string[], cursor: string | null = null) => ({
  items: ids.map((id) => ({ id })),
  pagination: { nextCursor: cursor, hasMore: cursor !== null },
  metadata: undefined,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("paginated requests", () => {
  it("loads only requested pages, retains filters and deduplicates by string ID", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(page(["1", "2"], "opaque-one"))
      .mockResolvedValueOnce(page(["2", "3"]));
    const list = createPagedList(fetcher);
    const filters = { repositoryId: "123", state: "merged" };
    await list.reset(filters);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await list.more();
    expect(fetcher.mock.calls[1][0]).toEqual(filters);
    expect(fetcher.mock.calls[1][1]).toBe("opaque-one");
    expect(list.items()).toEqual([{ id: "1" }, { id: "2" }, { id: "3" }]);
  });

  it("continues after an empty page when hasMore is true", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(page([], "keep-going"))
      .mockResolvedValueOnce(page(["1"]));
    const list = createPagedList(fetcher);
    await list.reset({});
    expect(list.pagination().hasMore).toBe(true);
    await list.more();
    expect(list.items()).toEqual([{ id: "1" }]);
  });

  it("resets cursors on filters and ignores stale responses even when abort is ignored", async () => {
    const old = deferred<ReturnType<typeof page>>();
    const fetcher = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(page(["new"], "new-cursor"));
    const list = createPagedList(fetcher);
    const first = list.reset({ search: "old" });
    await list.reset({ search: "new" });
    expect(fetcher.mock.calls[0][2].aborted).toBe(true);
    expect(fetcher.mock.calls[1][1]).toBeUndefined();
    old.resolve(page(["old"], "old-cursor"));
    await first;
    expect(list.items()).toEqual([{ id: "new" }]);
    expect(list.pagination().nextCursor).toBe("new-cursor");
  });

  it("prevents duplicate load-more requests while a page is pending", async () => {
    const pending = deferred<ReturnType<typeof page>>();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(page(["1"], "next"))
      .mockReturnValueOnce(pending.promise);
    const list = createPagedList(fetcher);
    await list.reset({});
    const first = list.more();
    await list.more();
    expect(fetcher).toHaveBeenCalledTimes(2);
    pending.resolve(page(["2"]));
    await first;
  });

  it("clears invalid cursors and retries from the first page", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(page(["1"], "expired"))
      .mockRejectedValueOnce(new ApiError(400, "INVALID_CURSOR"))
      .mockResolvedValueOnce(page(["fresh"]));
    const list = createPagedList(fetcher);
    await list.reset({ state: "open" });
    await list.more();
    expect(list.items()).toEqual([]);
    expect(list.pagination().hasMore).toBe(false);
    await list.retry();
    expect(fetcher.mock.calls[2][1]).toBeUndefined();
    expect(list.items()).toEqual([{ id: "fresh" }]);
  });

  it("clears user data and cancels in-flight work on disposal/sign-out", async () => {
    const pending = deferred<ReturnType<typeof page>>();
    const list = createPagedList(() => pending.promise);
    const request = list.reset({});
    list.clear();
    pending.resolve(page(["private"]));
    await request;
    expect(list.items()).toEqual([]);
    expect(list.metadata()).toBeUndefined();
    expect(list.loading()).toBe(false);
  });
});

describe("overview requests", () => {
  it("clears previous scope data while loading and ignores late responses", async () => {
    const old = deferred<{ count: number }>();
    const fetcher = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ count: 0 });
    const request = createLatestRequest(fetcher);
    const first = request.load("old-repo");
    await request.load("new-repo");
    old.resolve({ count: 50 });
    await first;
    expect(request.value()).toEqual({ count: 0 });
  });
});
