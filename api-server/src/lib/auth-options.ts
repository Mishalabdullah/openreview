import { organization } from "better-auth/plugins";
import type { Config } from "../config/env";

export function authOptions(config: Config) {
  return {
    appName: "OpenReview",
    baseURL: config.BETTER_AUTH_URL,
    basePath: "/api/auth",
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.FRONTEND_URL],
    disabledPaths: ["/get-access-token", "/refresh-token"],
    socialProviders: {
      github: {
        clientId: config.GITHUB_CLIENT_ID,
        clientSecret: config.GITHUB_CLIENT_SECRET,
      },
    },
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        allowDifferentEmails: false,
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    advanced: {
      disableOriginCheck: false,
      disableCSRFCheck: false,
      useSecureCookies: config.BETTER_AUTH_URL.startsWith("https:"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" as const },
      crossSubDomainCookies: { enabled: false },
    },
    // Never log upstream OAuth errors that may include provider payloads.
    logger: { disabled: true },
    plugins: [
      organization({
        teams: { enabled: true },
        requireEmailVerificationOnInvitation: true,
        // Invitations are persisted and discoverable via listUserInvitations.
        // Email delivery is intentionally not configured in this foundation.
      }),
    ],
  };
}
