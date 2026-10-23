import type { Hono, Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { and, eq, inArray, isNotNull, desc, sql, or } from "drizzle-orm";
import type { AppEnv } from "../types/env";
import { ApiError, apiErrorResponse, notFound } from "../lib/api-error";
import { hasReviewCredentials, reviewConfig } from "../lib/reviews/config";
import { enqueueRun, publicRun, repositoryRuns } from "../lib/reviews/jobs";
import { reviewRepository, reviewRun } from "../db/schema";

async function accessible(c: Context<AppEnv>) {
  const id = z.string().regex(/^\d+$/).safeParse(c.req.param("repositoryId"));
  if (!id.success) throw notFound();
  const [repo] = await c.var.github.inventory(id.data);
  return repo;
}

export function registerReviewRoutes(routes: Hono<AppEnv>) {
  routes.get("/repositories/:repositoryId/reviews/settings", async (c) => {
    const repo = await accessible(c);
    if (!hasReviewCredentials(c.var.config))
      return c.json({
        data: {
          enabled: false,
          available: false,
          canAdmin: repo.permissions?.admin === true,
        },
      });
    const [settings] = await c.var.db
      .select()
      .from(reviewRepository)
      .where(
        and(
          eq(reviewRepository.repositoryId, repo.id),
          eq(reviewRepository.installationId, repo.installationId),
        ),
      )
      .limit(1);
    return c.json({
      data: {
        enabled: Boolean(settings?.enabled && settings.enabledBy),
        available: true,
        canAdmin: repo.permissions?.admin === true,
      },
    });
  });
  routes.post(
    "/repositories/:repositoryId/reviews/settings",
    bodyLimit({
      maxSize: 1024,
      onError: (c) =>
        apiErrorResponse(
          c,
          new ApiError(
            413,
            "INVALID_QUERY",
            "Review settings payload is too large.",
          ),
        ),
    }),
    async (c) => {
      const repo = await accessible(c);
      if (repo.permissions?.admin !== true)
        throw new ApiError(
          403,
          "REVIEW_ADMIN_REQUIRED",
          "A repository administrator must enable automatic reviews.",
        );
      const body = z
        .object({ enabled: z.boolean() })
        .strict()
        .safeParse(await c.req.json().catch(() => null));
      if (!body.success)
        throw new ApiError(
          400,
          "INVALID_QUERY",
          "Expected an enabled boolean.",
        );
      if (body.data.enabled) {
        reviewConfig(c.var.config);
        if (!c.env.REVIEW_QUEUE)
          throw new ApiError(
            503,
            "REVIEW_QUEUE_UNAVAILABLE",
            "Review queue is not configured.",
          );
      }
      const values = {
        repositoryId: repo.id,
        installationId: repo.installationId,
        fullName: repo.full_name,
        enabled: body.data.enabled,
        enabledBy: c.var.user.id,
        updatedAt: new Date(),
      };
      await c.var.db
        .insert(reviewRepository)
        .values(values)
        .onConflictDoUpdate({
          target: reviewRepository.repositoryId,
          set: values,
        });
      return c.json({
        data: { enabled: body.data.enabled, available: true, canAdmin: true },
      });
    },
  );
  routes.get(
    "/repositories/:repositoryId/pull-requests/:number/reviews",
    async (c) => {
      const repo = await accessible(c);
      const number = z.coerce
        .number()
        .int()
        .positive()
        .safeParse(c.req.param("number"));
      if (!number.success) throw notFound();
      if (!hasReviewCredentials(c.var.config))
        return c.json({ data: [], available: false });
      return c.json({
        data: (await repositoryRuns(c.var.db, repo.id, number.data)).map(
          publicRun,
        ),
        available: true,
      });
    },
  );
  routes.post(
    "/repositories/:repositoryId/pull-requests/:number/reviews",
    async (c) => {
      const settings = reviewConfig(c.var.config);
      const producer = c.env.REVIEW_QUEUE;
      if (!producer)
        throw new ApiError(
          503,
          "REVIEW_QUEUE_UNAVAILABLE",
          "Review queue is not configured.",
        );
      const repo = await accessible(c);
      if (!repo.permissions?.push && !repo.permissions?.admin)
        throw new ApiError(
          403,
          "REVIEW_WRITE_REQUIRED",
          "Repository write access is required to request a review.",
        );
      const number = z.coerce
        .number()
        .int()
        .positive()
        .safeParse(c.req.param("number"));
      if (!number.success) throw notFound();
      const [enabled] = await c.var.db
        .select()
        .from(reviewRepository)
        .where(
          and(
            eq(reviewRepository.repositoryId, repo.id),
            eq(reviewRepository.installationId, repo.installationId),
            eq(reviewRepository.enabled, true),
            isNotNull(reviewRepository.enabledBy),
          ),
        )
        .limit(1);
      if (!enabled)
        throw new ApiError(
          409,
          "REVIEWS_NOT_ENABLED",
          "Enable reviews for this repository first.",
        );
      const pr = await c.var.github.pull(repo, number.data);
      if (pr.state !== "open" || pr.draft || !pr.head.sha)
        throw new ApiError(
          409,
          "PR_NOT_REVIEWABLE",
          "Only open, non-draft PRs can be reviewed.",
        );
      await c.var.db
        .insert(reviewRun)
        .values({
          id: crypto.randomUUID(),
          installationId: repo.installationId,
          repositoryId: repo.id,
          fullName: repo.full_name,
          pullNumber: number.data,
          headSha: pr.head.sha,
          model: settings.model,
        })
        .onConflictDoNothing();
      const [run] = await c.var.db
        .select()
        .from(reviewRun)
        .where(
          and(
            eq(reviewRun.repositoryId, repo.id),
            eq(reviewRun.installationId, repo.installationId),
            eq(reviewRun.pullNumber, number.data),
            eq(reviewRun.headSha, pr.head.sha),
          ),
        )
        .limit(1);
      // A manual retry preserves generated findings and retries publication only.
      if (
        run.status === "failed" ||
        run.status === "skipped" ||
        run.status === "superseded" ||
        (run.status === "completed" && run.publicationStatus === "failed")
      )
        await c.var.db
          .update(reviewRun)
          .set({
            attempts: 0,
            status: run.result ? "completed" : "queued",
            publicationStatus: "pending",
            dispatchedAt: null,
            leaseToken: null,
            leaseUntil: null,
            errorCode: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(reviewRun.id, run.id),
              eq(reviewRun.status, run.status),
              eq(reviewRun.publicationStatus, run.publicationStatus),
              sql`(${reviewRun.leaseUntil} is null or ${reviewRun.leaseUntil} < now())`,
            ),
          );
      if (run.status !== "completed" || run.publicationStatus !== "published") {
        try {
          await enqueueRun(c.var.db, producer, run.id);
        } catch {
          throw new ApiError(
            503,
            "REVIEW_QUEUE_UNAVAILABLE",
            "Review is saved and awaiting queue dispatch.",
          );
        }
      }
      return c.json({ data: { id: run.id } }, 202);
    },
  );
}

/** Outside the GitHub response cache: review progress must remain database-fresh. */
export function registerReviewOverlay(routes: Hono<AppEnv>) {
  for (const path of ["/pull-requests", "/dashboard/overview"])
    routes.use(path, async (c, next) => {
      await next();
      if (!hasReviewCredentials(c.var.config) || c.res.status !== 200) return;
      const result = (await c.res.clone().json()) as {
        data: Record<string, unknown> | Array<Record<string, unknown>>;
      };
      const pulls = (
        Array.isArray(result.data)
          ? result.data
          : result.data.recentPullRequests
      ) as Array<{
        repository: { id: string };
        number: number;
        head: { sha: string };
        appReview: unknown;
      }>;
      if (!Array.isArray(pulls)) return;
      const scope = pulls.map((pr) =>
        and(
          eq(reviewRun.repositoryId, pr.repository.id),
          eq(reviewRun.pullNumber, pr.number),
        ),
      );
      const current = pulls.map((pr) =>
        and(
          eq(reviewRun.repositoryId, pr.repository.id),
          eq(reviewRun.pullNumber, pr.number),
          eq(reviewRun.headSha, pr.head.sha),
        ),
      );
      const runs = pulls.length
        ? await c.var.db
            .selectDistinctOn([reviewRun.repositoryId, reviewRun.pullNumber])
            .from(reviewRun)
            .where(or(...scope))
            .orderBy(
              reviewRun.repositoryId,
              reviewRun.pullNumber,
              sql`case when ${or(...current)} then 0 else 1 end`,
              desc(reviewRun.createdAt),
            )
        : [];
      for (const pr of pulls) {
        const matching = runs.filter(
          (run) =>
            run.repositoryId === pr.repository.id &&
            run.pullNumber === pr.number,
        );
        const run =
          matching.find((run) => run.headSha === pr.head.sha) ?? matching[0];
        pr.appReview = run
          ? { ...publicRun(run), stale: run.headSha !== pr.head.sha }
          : null;
      }
      if (!Array.isArray(result.data)) {
        const repositories = await c.var.github.inventory(
          c.req.query("repositoryId"),
        );
        const ids = repositories.map((repo) => repo.id);
        const [metrics] = ids.length
          ? await c.var.db
              .select({
                completed: sql<number>`count(*) filter (where ${reviewRun.status} = 'completed')::int`,
                pending: sql<number>`count(*) filter (where ${reviewRun.status} in ('queued', 'reviewing'))::int`,
                failed: sql<number>`count(*) filter (where ${reviewRun.status} = 'failed' or ${reviewRun.publicationStatus} = 'failed')::int`,
              })
              .from(reviewRun)
              .where(inArray(reviewRun.repositoryId, ids))
          : [{ completed: 0, pending: 0, failed: 0 }];
        result.data.reviewMetrics = metrics;
      }
      c.res = c.json(result);
    });
}
