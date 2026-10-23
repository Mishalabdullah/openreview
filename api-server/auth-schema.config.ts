import { betterAuth } from "better-auth";
import { authOptions } from "./src/lib/auth-options";

// Schema generation only. No credentials, Worker bindings or DB I/O required.
export const auth = betterAuth(
  authOptions({
    ENVIRONMENT: "local",
    BETTER_AUTH_URL: "http://localhost:1337",
    FRONTEND_URL: "http://localhost:5173",
    BETTER_AUTH_SECRET: "schema-generation-only-not-a-runtime-secret",
    GITHUB_CLIENT_ID: "schema-generation-only",
    GITHUB_CLIENT_SECRET: "schema-generation-only",
    GITHUB_WEBHOOK_SECRET: "schema-generation-only",
  }),
);
