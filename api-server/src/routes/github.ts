import { timingSafeEqual } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { account } from "../db/auth-schema";
import {
  ApiError,
  apiErrorResponse,
  notFound,
  reauthorizationRequired,
} from "../lib/api-error";
import { GitHubService } from "../lib/github/service";
import {
  OpaqueTokens,
  pageQuery,
  pullQuery,
  repositoryQuery,
} from "../lib/github/pagination";
import { file, mapPullRequest } from "../lib/github/schemas";
import { requireAuth } from "../middleware/auth";
import type { AppEnv } from "../types/env";

function parseQuery<T>(c: Context<AppEnv>, schema: z.ZodType<T>): T {
  const url = new URL(c.req.url);
  if (
    [...url.searchParams.keys()].some(
      (key) => url.searchParams.getAll(key).length !== 1,
    )
  ) {
    throw new ApiError(
      400,
      "INVALID_QUERY",
      "Query parameters must not be repeated.",
    );
  }
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success)
    throw new ApiError(400, "INVALID_QUERY", "Invalid query parameters.");
  return parsed.data;
}

async function githubService(c: Context<AppEnv>, fetcher?: typeof fetch) {
  const [linked] = await c.var.db
    .select({ id: account.id })
    .from(account)
    .where(
      and(eq(account.userId, c.var.user.id), eq(account.providerId, "github")),
    )
    .limit(1);
  if (!linked) return null;
  let token: Awaited<ReturnType<typeof c.var.auth.api.getAccessToken>>;
  try {
    // Select the local Better Auth account row, not the GitHub provider account ID.
    token = await c.var.auth.api.getAccessToken({
      body: { accountId: linked.id, userId: c.var.user.id },
    });
  } catch {
    throw reauthorizationRequired();
  }
  if (
    !token.accessToken ||
    (token.accessTokenExpiresAt &&
      new Date(token.accessTokenExpiresAt).getTime() <= Date.now())
  )
    throw reauthorizationRequired();
  return new GitHubService(
    token.accessToken,
    c.var.config.BETTER_AUTH_SECRET,
    c.var.user.id,
    fetcher,
  );
}

function installURL(c: Context<AppEnv>) {
  if (!c.var.config.GITHUB_APP_SLUG)
    throw new ApiError(
      503,
      "GITHUB_NOT_CONFIGURED",
      "The GitHub App installation flow is not configured.",
    );
  return `${c.var.config.BETTER_AUTH_URL}/api/v1/github/install`;
}

export function githubRoutes(fetcher?: typeof fetch) {
  const routes = new Hono<AppEnv>();
  const requireGitHub: MiddlewareHandler<AppEnv> = async (c, next) => {
    try {
      const service = await githubService(c, fetcher);
      if (!service) {
        if (c.req.path === "/api/v1/github/connection") {
          return c.json({
            data: {
              status: "disconnected",
              account: null,
              installations: [],
              installUrl: null,
              lastSyncedAt: null,
            },
            pagination: { nextCursor: null, hasMore: false },
          });
        }
        throw reauthorizationRequired();
      }
      c.set("github", service);
      await next();
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === "GITHUB_REAUTH_REQUIRED" &&
        c.req.path === "/api/v1/github/connection"
      ) {
        return c.json({
          data: {
            status: "reauthorization_required",
            account: null,
            installations: [],
            installUrl: null,
            lastSyncedAt: null,
          },
          pagination: { nextCursor: null, hasMore: false },
        });
      }
      throw error;
    }
  };
  for (const path of [
    "/github/*",
    "/repositories/*",
    "/pull-requests/*",
    "/dashboard/*",
  ]) {
    routes.use(path, requireAuth, requireGitHub);
  }

  routes.get("/github/connection", async (c) => {
    const query = parseQuery(c, pageQuery);
    const result = await c.var.github.connection(query.limit, query.cursor);
    if (result.data.status === "installation_required")
      result.data.installUrl = installURL(c);
    return c.json(result);
  });

  routes.get("/repositories", async (c) =>
    c.json(await c.var.github.repositories(parseQuery(c, repositoryQuery))),
  );

  routes.get("/pull-requests", async (c) => {
    const query = parseQuery(c, pullQuery);
    const repos = await c.var.github.inventory(query.repositoryId);
    return c.json(
      query.repositoryId
        ? await c.var.github.repositoryPulls(repos[0], query)
        : await c.var.github.combinedPulls(repos, query),
    );
  });

  routes.get("/dashboard/overview", async (c) => {
    const query = parseQuery(
      c,
      z.object({ repositoryId: z.string().regex(/^\d+$/).optional() }),
    );
    return c.json(await c.var.github.overview(query.repositoryId));
  });

  const detailParams = z.object({
    repositoryId: z.string().regex(/^\d+$/),
    number: z.coerce.number().int().min(1).max(2_147_483_647),
  });
  routes.get("/repositories/:repositoryId/pull-requests/:number", async (c) => {
    const params = detailParams.safeParse(c.req.param());
    if (!params.success) throw notFound();
    const [repo] = await c.var.github.inventory(params.data.repositoryId);
    const pr = await c.var.github.pull(repo, params.data.number);
    return c.json({
      data: {
        ...mapPullRequest(pr, repo),
        body: pr.body,
        additions: pr.additions ?? null,
        deletions: pr.deletions ?? null,
        changedFiles: pr.changed_files ?? null,
        mergeable: pr.mergeable ?? null,
      },
    });
  });

  routes.get(
    "/repositories/:repositoryId/pull-requests/:number/files",
    async (c) => {
      const params = detailParams.safeParse(c.req.param());
      if (!params.success) throw notFound();
      const query = parseQuery(c, pageQuery);
      const purpose = `files:${params.data.repositoryId}:${params.data.number}`;
      const state = query.cursor
        ? await c.var.github.tokens.open(
            purpose,
            query.cursor,
            z.object({
              page: z.number().int().min(1).max(3000),
              limit: z.number().int().min(1).max(100),
            }),
          )
        : { page: 1, limit: query.limit };
      if (state.limit !== query.limit)
        throw new ApiError(
          400,
          "INVALID_CURSOR",
          "Cursor page size has changed. Start again.",
        );
      const [repo] = await c.var.github.inventory(params.data.repositoryId);
      const response = await c.var.github.client.get(
        `/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/pulls/${params.data.number}/files`,
        z.array(file),
        { per_page: query.limit, page: state.page },
      );
      return c.json({
        data: response.data.map((item) => ({
          filename: item.filename,
          previousFilename: item.previous_filename,
          status: item.status,
          additions: item.additions,
          deletions: item.deletions,
          patch: item.patch,
        })),
        pagination: {
          nextCursor: response.hasNext
            ? await c.var.github.tokens.seal(purpose, {
                page: state.page + 1,
                limit: query.limit,
              })
            : null,
          hasMore: response.hasNext,
        },
      });
    },
  );

  routes.get("/github/install", async (c) => {
    installURL(c);
    const nonce = crypto.randomUUID();
    const state = await c.var.github.tokens.seal("installation", { nonce });
    setCookie(c, "openreview.github_install_state", nonce, {
      httpOnly: true,
      secure: c.var.config.BETTER_AUTH_URL.startsWith("https:"),
      sameSite: "Lax",
      path: "/api/v1/github/install",
      maxAge: 900,
    });
    const destination = new URL(
      `https://github.com/apps/${c.var.config.GITHUB_APP_SLUG}/installations/new`,
    );
    destination.searchParams.set("state", state);
    return c.redirect(destination.href);
  });

  routes.get("/github/install/callback", async (c) => {
    const query = parseQuery(
      c,
      z.object({
        state: z.string().max(16_384),
        installation_id: z.string().regex(/^\d+$/),
        setup_action: z.string().optional(),
      }),
    );
    const state = await new OpaqueTokens(
      c.var.config.BETTER_AUTH_SECRET,
      c.var.user.id,
    ).open("installation", query.state, z.object({ nonce: z.string().uuid() }));
    const cookie = getCookie(c, "openreview.github_install_state");
    if (!cookie)
      throw new ApiError(
        400,
        "INVALID_INSTALLATION_STATE",
        "Restart the GitHub installation flow.",
      );
    const digest = (value: string) =>
      crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    if (
      !timingSafeEqual(
        new Uint8Array(await digest(cookie)),
        new Uint8Array(await digest(state.nonce)),
      )
    ) {
      throw new ApiError(
        400,
        "INVALID_INSTALLATION_STATE",
        "Restart the GitHub installation flow.",
      );
    }
    deleteCookie(c, "openreview.github_install_state", {
      path: "/api/v1/github/install",
    });
    for (let page = 1; page <= 10; page++) {
      const response = await c.var.github.installationPage(page);
      if (
        response.data.installations.some(
          (installation) =>
            installation.id === query.installation_id &&
            !installation.suspended_at,
        )
      ) {
        return c.redirect(
          `${c.var.config.FRONTEND_URL}/dashboard?github=connected`,
        );
      }
      if (!response.hasNext) break;
    }
    throw notFound();
  });

  routes.onError((error, c) => {
    if (
      error instanceof ApiError &&
      error.code === "GITHUB_REAUTH_REQUIRED" &&
      c.req.path === "/api/v1/github/connection"
    ) {
      return c.json({
        data: {
          status: "reauthorization_required",
          account: null,
          installations: [],
          installUrl: null,
          lastSyncedAt: null,
        },
        pagination: { nextCursor: null, hasMore: false },
      });
    }
    if (error instanceof ApiError) return apiErrorResponse(c, error);
    console.error(
      JSON.stringify({
        event: "github_request_failed",
        requestId: c.var.requestId,
      }),
    );
    return apiErrorResponse(
      c,
      new ApiError(500, "INTERNAL_ERROR", "An unexpected error occurred."),
    );
  });
  return routes;
}
