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
  return {
    connection: (cursor: string | undefined, signal: AbortSignal) =>
      request<ConnectionResponse>(
        `/api/v1/github/connection?${queryString({ limit: 30, cursor })}`,
        signal,
      ),
    repositories: (
      filters: RepositoryFilters,
      cursor: string | undefined,
      signal: AbortSignal,
    ) =>
      request<Page<Repository>>(
        `/api/v1/repositories?${queryString({ ...filters, limit: 30, cursor })}`,
        signal,
      ),
    pulls: (
      filters: PullFilters,
      cursor: string | undefined,
      signal: AbortSignal,
    ) =>
      request<Page<PullRequest>>(
        `/api/v1/pull-requests?${queryString({ ...filters, limit: 30, cursor })}`,
        signal,
      ),
    overview: (repositoryId: string | undefined, signal: AbortSignal) =>
      request<Envelope<Overview>>(
        `/api/v1/dashboard/overview?${queryString({ repositoryId })}`,
        signal,
      ),
  };
}
