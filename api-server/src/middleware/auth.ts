import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../types/env";
import { ApiError, apiErrorResponse } from "../lib/api-error";

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const { response: result, headers } = await c.var.auth.api.getSession({
    headers: c.req.raw.headers,
    returnHeaders: true,
    // No cookie cache: revoked sessions must stop working immediately.
    query: { disableCookieCache: true },
  });
  for (const cookie of headers.getSetCookie())
    c.header("Set-Cookie", cookie, { append: true });
  if (!result)
    return apiErrorResponse(
      c,
      new ApiError(
        401,
        "SESSION_REQUIRED",
        "Sign in to OpenReview to continue.",
      ),
    );
  c.set("user", result.user);
  c.set("session", result.session);
  c.header("Cache-Control", "no-store");
  await next();
});
