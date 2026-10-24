import type { Auth } from "../lib/auth";
import type { Config } from "../config/env";
import type { Database } from "../db";
import type { GitHubService } from "../lib/github/service";
import type { ReviewQueue } from "../lib/reviews/jobs";

// Public vars come from `wrangler types`; secrets are supplied at runtime.
export type Bindings = Omit<CloudflareBindings, "REVIEW_QUEUE"> & {
  BETTER_AUTH_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  OPENAI_API_KEY?: string;
  OPEN_AI_KEY?: string;
  OPENAI_REVIEW_MODEL?: string;
  REVIEW_QUEUE?: ReviewQueue;
  DATABASE_URL?: string;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    requestId: string;
    github: GitHubService;
    config: Config;
    db: Database;
    auth: Auth;
    user: Auth["$Infer"]["Session"]["user"];
    session: Auth["$Infer"]["Session"]["session"];
  };
};
