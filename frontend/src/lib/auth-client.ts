import { createAuthClient } from "better-auth/solid";
import { organizationClient } from "better-auth/client/plugins";
import { API_URL } from "./api";

export const authClient = createAuthClient({
  baseURL: API_URL,
  basePath: "/api/auth",
  fetchOptions: { credentials: "include" },
  plugins: [organizationClient({ teams: { enabled: true } })],
});

export type AuthUser = typeof authClient.$Infer.Session.user;
