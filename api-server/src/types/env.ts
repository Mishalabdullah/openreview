import type { Auth } from "../lib/auth";
import type { Config } from "../config/env";
import type { Database } from "../db";
import type { GitHubService } from "../lib/github/service";

// Public vars come from `wrangler types`; secrets are supplied at runtime.
export type Bindings = CloudflareBindings & {
  BETTER_AUTH_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_SLUG?: string;
  DATABASE_URL?: string;
  // Optional until separately provisioned for each deployed environment.
  HYPERDRIVE?: { connectionString: string };
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
