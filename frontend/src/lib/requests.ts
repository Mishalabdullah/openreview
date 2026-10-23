import { batch, createSignal } from "solid-js";
import { ApiError } from "./api";
import type { Pagination } from "./github-types";

const noMore: Pagination = { nextCursor: null, hasMore: false };
const asError = (error: unknown) =>
  error instanceof ApiError ? error : new ApiError(0, "NETWORK_ERROR");

export type ListResult<T, M> = {
  items: T[];
  pagination: Pagination;
  metadata: M;
};

/** Explicit actions, request cancellation, and generations also protect against fetchers that ignore abort. */
export function createPagedList<T extends { id: string }, Q, M = undefined>(
  fetchPage: (
    query: Q,
    cursor: string | undefined,
    signal: AbortSignal,
  ) => Promise<ListResult<T, M>>,
) {
  const [items, setItems] = createSignal<T[]>([]);
  const [metadata, setMetadata] = createSignal<M>();
  const [pagination, setPagination] = createSignal<Pagination>(noMore);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<ApiError | null>(null);
  let generation = 0;
  let controller: AbortController | undefined;
  let query: Q;

  function clear() {
    generation++;
    controller?.abort();
    batch(() => {
      setItems([]);
      setMetadata(undefined);
      setPagination(noMore);
      setLoading(false);
      setError(null);
    });
  }

  async function load(append: boolean) {
    if (loading()) return;
    const cursor = append ? pagination().nextCursor : undefined;
    if (append && (!pagination().hasMore || cursor === null)) return;
    const current = ++generation;
    controller = new AbortController();
    const signal = controller.signal;
    batch(() => {
      setLoading(true);
      setError(null);
    });
    try {
      const result = await fetchPage(query, cursor ?? undefined, signal);
      if (current !== generation || signal.aborted) return;
      batch(() => {
        setItems((existing) => [
          ...new Map(
            (append ? [...existing, ...result.items] : result.items).map(
              (item) => [item.id, item],
            ),
          ).values(),
        ]);
        setMetadata(() => result.metadata);
        setPagination(result.pagination);
      });
    } catch (cause) {
      if (current !== generation || signal.aborted) return;
      const failure = asError(cause);
      batch(() => {
        setError(failure);
        if (failure.code === "INVALID_CURSOR") {
          setItems([]);
          setMetadata(undefined);
          setPagination(noMore);
        }
      });
    } finally {
      if (current === generation) setLoading(false);
    }
  }

  return {
    items,
    metadata,
    pagination,
    loading,
    error,
    clear,
    reset(next: Q) {
      clear();
      query = next;
      return load(false);
    },
    more: () => load(true),
    retry: () =>
      load(pagination().hasMore && error()?.code !== "INVALID_CURSOR"),
  };
}

export function createLatestRequest<T, Q>(
  fetchValue: (query: Q, signal: AbortSignal) => Promise<T>,
) {
  const [value, setValue] = createSignal<T>();
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<ApiError | null>(null);
  let generation = 0;
  let controller: AbortController | undefined;
  let query: Q;
  function clear() {
    generation++;
    controller?.abort();
    batch(() => {
      setValue(undefined);
      setLoading(false);
      setError(null);
    });
  }
  async function load(next: Q) {
    clear();
    query = next;
    const current = generation;
    controller = new AbortController();
    const signal = controller.signal;
    setLoading(true);
    try {
      const result = await fetchValue(next, signal);
      if (current === generation && !signal.aborted) setValue(() => result);
    } catch (cause) {
      if (current === generation && !signal.aborted) setError(asError(cause));
    } finally {
      if (current === generation) setLoading(false);
    }
  }
  return { value, loading, error, clear, load, retry: () => load(query) };
}
