import { z } from "zod";
import { ApiError, notFound, reauthorizationRequired } from "../api-error";

export type GitHubFetch = typeof fetch;

export class GitHubClient {
  private calls = 0;
  constructor(
    private token: string,
    private fetcher: GitHubFetch = fetch,
  ) {}

  async get<T>(
    path: string,
    schema: z.ZodType<T>,
    parameters: Record<string, string | number | undefined> = {},
  ) {
    // Never follow arbitrary API URLs supplied by query parameters or upstream JSON.
    if (!path.startsWith("/") || path.startsWith("//") || ++this.calls > 45) {
      throw new ApiError(
        503,
        "GITHUB_QUERY_TOO_LARGE",
        "Narrow the repository filter and retry.",
      );
    }
    const url = new URL(path, "https://api.github.com");
    if (url.origin !== "https://api.github.com") {
      throw new ApiError(
        502,
        "GITHUB_UNAVAILABLE",
        "Invalid GitHub API destination.",
      );
    }
    for (const [key, value] of Object.entries(parameters))
      if (value !== undefined) url.searchParams.set(key, String(value));
    let response: Response;
    try {
      response = await this.fetcher(url.href, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          "User-Agent": "OpenReview",
        },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ApiError(
        502,
        "GITHUB_UNAVAILABLE",
        "GitHub is temporarily unavailable.",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      const retry = response.headers.get("retry-after");
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (retry || response.headers.get("x-ratelimit-remaining") === "0"))
      ) {
        const reset = Number(response.headers.get("x-ratelimit-reset"));
        const seconds =
          retry && /^\d+$/.test(retry)
            ? retry
            : String(
                Number.isFinite(reset) && reset > Date.now() / 1000
                  ? Math.ceil(reset - Date.now() / 1000)
                  : 60,
              );
        throw new ApiError(
          429,
          "GITHUB_RATE_LIMITED",
          "GitHub rate limit reached. Please retry later.",
          seconds,
        );
      }
      if (response.status === 401) throw reauthorizationRequired();
      if (response.status === 404) throw notFound();
      if (response.status === 403)
        throw new ApiError(
          403,
          "GITHUB_PERMISSION_REQUIRED",
          "Approve the GitHub App permissions required for this operation.",
        );
      if (response.status === 422)
        throw new ApiError(
          503,
          "GITHUB_QUERY_UNSUPPORTED",
          "GitHub cannot complete this query. Narrow the repository filter.",
        );
      throw new ApiError(
        502,
        "GITHUB_UNAVAILABLE",
        "GitHub is temporarily unavailable.",
      );
    }
    // GitHub pages are bounded, but descriptions/bodies may be large. Enforce a byte ceiling.
    const reader = response.body?.getReader();
    if (!reader)
      throw new ApiError(
        502,
        "GITHUB_UNAVAILABLE",
        "GitHub returned an invalid response.",
      );
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8 * 1024 * 1024) {
          await reader.cancel();
          throw new Error("Response too large");
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const parsed = schema.safeParse(
        JSON.parse(new TextDecoder().decode(bytes)),
      );
      if (!parsed.success) throw new Error("Invalid response");
      return {
        data: parsed.data,
        hasNext: /<[^>]+>;\s*rel="next"/.test(
          response.headers.get("link") ?? "",
        ),
      };
    } catch {
      throw new ApiError(
        502,
        "GITHUB_UNAVAILABLE",
        "GitHub returned an invalid or oversized response.",
      );
    } finally {
      reader.releaseLock();
    }
  }
}
