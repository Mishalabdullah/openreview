import { createApiClient, type ApiError } from "./api";
import type {
  ConnectionResponse,
  Envelope,
  Overview,
  Page,
  PullFilters,
  PullRequest,
  Repository,
  RepositoryFilters,
} from "./github-types";

export function queryString(
  values: Record<string, string | number | undefined>,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  return query.toString();
}

export function createGitHubApi(onError: (error: ApiError) => void) {
  const request = createApiClient(onError);
  const refreshPending = new Map<string, number>();
  function fresh(key: string) {
    const until = refreshPending.get(key) ?? 0;
    refreshPending.delete(key);
    return until > Date.now() ? "true" : undefined;
  }
  return {
    // Each dashboard section bypasses the backend cache once after explicit refresh.
    refresh: () => {
      for (const key of ["connection", "repositories", "pulls", "overview"])
        refreshPending.set(key, Date.now() + 30_000);
    },
    connection: (cursor: string | undefined, signal: AbortSignal) =>
      request<ConnectionResponse>(
        `/api/v1/github/connection?${queryString({ limit: 30, cursor, refresh: fresh("connection") })}`,
        signal,
      ),
    repositories: (
      filters: RepositoryFilters,
      cursor: string | undefined,
      signal: AbortSignal,
    ) =>
      request<Page<Repository>>(
        `/api/v1/repositories?${queryString({ ...filters, limit: 30, cursor, refresh: fresh("repositories") })}`,
        signal,
      ),
    pulls: (
      filters: PullFilters,
      cursor: string | undefined,
      signal: AbortSignal,
    ) =>
      request<Page<PullRequest>>(
        `/api/v1/pull-requests?${queryString({ ...filters, limit: 30, cursor, refresh: fresh("pulls") })}`,
        signal,
      ),
    overview: (repositoryId: string | undefined, signal: AbortSignal) =>
      request<Envelope<Overview>>(
        `/api/v1/dashboard/overview?${queryString({ repositoryId, refresh: fresh("overview") })}`,
        signal,
      ),
  };
}
