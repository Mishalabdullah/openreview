export const API_URL = (
  import.meta.env.VITE_API_URL || "http://localhost:1337"
).replace(/\/+$/, "");

/** All application API calls must carry the HttpOnly session cookie. */
export function apiFetch(path: `/api/${string}`, options: RequestInit = {}) {
  return fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include",
  });
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly retryAt: number | null;

  constructor(
    status: number,
    code: string,
    requestId: string | null = null,
    retryAt: number | null = null,
  ) {
    super(apiErrorMessage(code));
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAt = retryAt;
  }
}

export function apiErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    REVIEWS_NOT_CONFIGURED:
      "Code review configuration is incomplete on the backend.",
    REVIEW_QUEUE_UNAVAILABLE:
      "The background review queue is unavailable. Please retry later.",
    REVIEWS_NOT_ENABLED:
      "Enable reviews for this repository first. A repository administrator can do this from its PR page.",
    REVIEW_ADMIN_REQUIRED:
      "A repository administrator must enable automatic reviews.",
    REVIEW_WRITE_REQUIRED:
      "Repository write access is required to request a review.",
    PR_NOT_REVIEWABLE: "Only open, non-draft PRs can be reviewed.",
    SESSION_REQUIRED:
      "Your OpenReview session has expired. Please sign in again.",
    GITHUB_REAUTH_REQUIRED:
      "GitHub authorization has expired or was revoked. Reconnect GitHub to continue.",
    GITHUB_INSTALLATION_REQUIRED:
      "Install the GitHub App and select repositories to grant access.",
    GITHUB_PERMISSION_REQUIRED:
      "The GitHub App needs additional permissions. Ask an installation owner to approve read access to metadata and pull requests.",
    RESOURCE_NOT_FOUND:
      "This resource may no longer exist or you may no longer have access. Refresh the repository list.",
    GITHUB_RATE_LIMITED:
      "GitHub is rate limiting requests. Wait before trying again.",
    GITHUB_UNAVAILABLE: "GitHub is temporarily unavailable. Please try again.",
    GITHUB_INCOMPLETE_RESULTS:
      "GitHub returned incomplete results. Please retry; no partial totals are being shown.",
    GITHUB_QUERY_TOO_LARGE:
      "There are too many repositories for a combined view. Select a repository to continue.",
    GITHUB_SEARCH_LIMIT:
      "GitHub's combined search limit was reached. Select a repository to browse its full PR history.",
    GITHUB_QUERY_UNSUPPORTED:
      "This combined query is not supported. Select a repository to continue.",
    GITHUB_NOT_CONFIGURED:
      "GitHub App installation is not configured on the backend. Ask an administrator to set GITHUB_APP_SLUG and the app setup URL.",
    INVALID_CURSOR:
      "This page cursor expired or access changed. Start again from the first page.",
    INVALID_QUERY:
      "These filters are not valid. Check the filters and try again.",
    NETWORK_ERROR:
      "Unable to reach the API. Check your connection and try again.",
    INVALID_RESPONSE:
      "The API returned an unexpected response. Please try again.",
  };
  return messages[code] ?? "Unable to load this section. Please try again.";
}

export function retryAfterTimestamp(value: string | null, now = Date.now()) {
  if (!value) return now + 60_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(now, date) : now + 60_000;
}

/** A dashboard-scoped transport: no shared user data or provider tokens. */
export function createApiClient(onError: (error: ApiError) => void = () => {}) {
  let rateLimitedUntil = 0;
  return async function request<T>(
    path: `/api/${string}`,
    signal?: AbortSignal,
  ): Promise<T> {
    if (Date.now() < rateLimitedUntil) {
      throw new ApiError(429, "GITHUB_RATE_LIMITED", null, rateLimitedUntil);
    }
    let response: Response;
    try {
      response = await apiFetch(path, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ApiError(0, "NETWORK_ERROR");
    }
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      const code =
        typeof result?.error?.code === "string"
          ? result.error.code
          : response.status === 401
            ? "SESSION_REQUIRED"
            : "UNKNOWN_ERROR";
      const requestId =
        typeof result?.error?.requestId === "string"
          ? result.error.requestId
          : response.headers.get("X-Request-ID");
      const retryAt =
        response.status === 429
          ? retryAfterTimestamp(response.headers.get("Retry-After"))
          : null;
      if (retryAt !== null) rateLimitedUntil = retryAt;
      const error = new ApiError(response.status, code, requestId, retryAt);
      if (!signal?.aborted) onError(error);
      throw error;
    }
    if (!result || typeof result !== "object" || !("data" in result))
      throw new ApiError(502, "INVALID_RESPONSE");
    return result as T;
  };
}
