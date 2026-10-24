import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../types/env";

export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
    public retryAfter?: string,
  ) {
    super(message);
  }
}

export function apiErrorResponse(c: Context<AppEnv>, error: ApiError) {
  if (error.retryAfter) c.header("Retry-After", error.retryAfter);
  return c.json(
    {
      error: {
        code: error.code,
        message: error.message,
        requestId: c.var.requestId,
      },
    },
    error.status,
  );
}

export const reauthorizationRequired = () =>
  new ApiError(403, "GITHUB_REAUTH_REQUIRED", "Reconnect GitHub to continue.");
export const notFound = () =>
  new ApiError(
    404,
    "RESOURCE_NOT_FOUND",
    "Repository or pull request not found.",
  );
