import type { Config } from "../../config/env";
import { ApiError } from "../api-error";

export function reviewConfig(config: Config) {
  const apiKey = config.OPENAI_API_KEY ?? config.OPEN_AI_KEY;
  if (
    !apiKey ||
    !config.GITHUB_APP_ID ||
    !config.GITHUB_APP_PRIVATE_KEY ||
    !config.GITHUB_APP_SLUG
  ) {
    throw new ApiError(
      503,
      "REVIEWS_NOT_CONFIGURED",
      "Code review credentials are not fully configured.",
    );
  }
  return {
    apiKey,
    appId: config.GITHUB_APP_ID,
    privateKey: config.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
    slug: config.GITHUB_APP_SLUG,
    model: config.OPENAI_REVIEW_MODEL,
  };
}

export function hasReviewCredentials(config: Config): boolean {
  try {
    reviewConfig(config);
    return true;
  } catch {
    return false;
  }
}

export class ReviewFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super(code);
  }
}
