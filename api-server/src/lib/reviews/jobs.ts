import {
  and,
  eq,
  inArray,
  isNull,
  isNotNull,
  lt,
  or,
  sql,
  desc,
} from "drizzle-orm";
import type { Database } from "../../db";
import { reviewRepository, reviewRun } from "../../db/schema";
import type { Config } from "../../config/env";
import { reviewConfig, ReviewFailure } from "./config";
import {
  installationClient,
  publishReview,
  reviewInput,
  addReviewEyes,
  removeReviewEyes,
  type AppGitHub,
} from "./github";
import { generateReview } from "./model";

export type ReviewMessage = { runId: string };
export type ReviewQueue = { send(message: ReviewMessage): Promise<void> };
export type Run = typeof reviewRun.$inferSelect;
export const publicRun = (run: Run) => ({
  id: run.id,
  repositoryId: run.repositoryId,
  pullNumber: run.pullNumber,
  headSha: run.headSha,
  status: run.status,
  publicationStatus: run.publicationStatus,
  result: run.result,
  model: run.model,
  githubReviewUrl: run.githubReviewUrl,
  errorCode: run.errorCode,
  createdAt: run.createdAt.toISOString(),
  updatedAt: run.updatedAt.toISOString(),
});

export async function enqueueRun(
  db: Database,
  queue: ReviewQueue,
  runId: string,
) {
  await queue.send({ runId });
  await db
    .update(reviewRun)
    .set({ dispatchedAt: new Date() })
    .where(eq(reviewRun.id, runId));
}

/** Durable outbox recovery: queue messages are hints; PostgreSQL is authoritative. */
export async function dispatchPending(db: Database, queue: ReviewQueue) {
  const now = new Date();
  await db
    .update(reviewRun)
    .set({
      status: sql`case when ${reviewRun.result} is not null then 'completed' else 'failed' end`,
      publicationStatus: "failed",
      errorCode: "RETRY_LIMIT",
      leaseToken: null,
      leaseUntil: null,
      updatedAt: now,
    })
    .where(
      and(
        or(
          inArray(reviewRun.status, ["queued", "reviewing"]),
          and(
            eq(reviewRun.status, "completed"),
            eq(reviewRun.publicationStatus, "pending"),
          ),
        ),
        sql`${reviewRun.attempts} >= 4`,
        or(isNull(reviewRun.leaseUntil), lt(reviewRun.leaseUntil, now)),
      ),
    );
  const runs = await db
    .select({ id: reviewRun.id })
    .from(reviewRun)
    .where(
      and(
        or(
          eq(reviewRun.status, "queued"),
          and(eq(reviewRun.status, "reviewing"), lt(reviewRun.leaseUntil, now)),
          and(
            eq(reviewRun.status, "completed"),
            inArray(reviewRun.publicationStatus, ["pending", "failed"]),
          ),
        ),
        or(
          isNull(reviewRun.dispatchedAt),
          lt(reviewRun.dispatchedAt, new Date(now.getTime() - 5 * 60_000)),
        ),
        or(isNull(reviewRun.leaseUntil), lt(reviewRun.leaseUntil, now)),
        lt(reviewRun.attempts, 4),
      ),
    )
    .orderBy(reviewRun.createdAt)
    .limit(20);
  for (const run of runs) await enqueueRun(db, queue, run.id);
  return runs.length;
}

export async function processReview(
  db: Database,
  config: Config,
  runId: string,
  fetcher?: typeof fetch,
): Promise<"done" | "retry"> {
  const settings = reviewConfig(config);
  const now = new Date();
  const leaseToken = crypto.randomUUID();
  const [run] = await db
    .update(reviewRun)
    .set({
      leaseToken,
      leaseUntil: new Date(now.getTime() + 10 * 60_000),
      attempts: sql`${reviewRun.attempts} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(reviewRun.id, runId),
        lt(reviewRun.attempts, 4),
        or(isNull(reviewRun.leaseUntil), lt(reviewRun.leaseUntil, now)),
        or(
          inArray(reviewRun.status, ["queued", "reviewing"]),
          and(
            eq(reviewRun.status, "completed"),
            inArray(reviewRun.publicationStatus, ["pending", "failed"]),
          ),
        ),
      ),
    )
    .returning();
  if (!run) {
    const [existing] = await db
      .select()
      .from(reviewRun)
      .where(eq(reviewRun.id, runId))
      .limit(1);
    return existing?.leaseUntil && existing.leaseUntil > now ? "retry" : "done";
  }
  const update = async (values: Partial<typeof reviewRun.$inferInsert>) => {
    const updated = await db
      .update(reviewRun)
      .set({ ...values, updatedAt: new Date() })
      .where(
        and(
          eq(reviewRun.id, runId),
          eq(reviewRun.leaseToken, leaseToken),
          sql`${reviewRun.leaseUntil} > now()`,
        ),
      )
      .returning({ id: reviewRun.id });
    if (updated.length !== 1) throw new ReviewFailure("REVIEW_LEASE_LOST");
  };
  let hasResult = run.result !== null;
  let progress: { client: AppGitHub; reactionId: string } | undefined;
  try {
    const [repository] = await db
      .select()
      .from(reviewRepository)
      .where(
        and(
          eq(reviewRepository.repositoryId, run.repositoryId),
          eq(reviewRepository.installationId, run.installationId),
          eq(reviewRepository.enabled, true),
          isNotNull(reviewRepository.enabledBy),
        ),
      )
      .limit(1);
    if (!repository) throw new ReviewFailure("REPOSITORY_NOT_ENABLED");
    const client = await installationClient(
      settings,
      run.installationId,
      fetcher,
    );
    await update({
      status: run.result ? "completed" : "reviewing",
      errorCode: null,
    });
    // Live permissions, current SHA and diff checks run even when retrying publication.
    const context = await reviewInput(
      client,
      run.fullName,
      run.pullNumber,
      run.headSha,
      run.repositoryId,
    );
    try {
      progress = {
        client,
        reactionId: await addReviewEyes(client, run.fullName, run.pullNumber),
      };
    } catch {
      console.warn(
        JSON.stringify({
          event: "review_reaction_failed",
          runId,
          phase: "add",
        }),
      );
    }
    const result =
      run.result ??
      (await generateReview(
        settings.apiKey,
        run.model,
        context.input,
        fetcher,
      ));
    if (!run.result) {
      result.partial = context.limitations.some(
        (value) => !value.startsWith("Review is limited"),
      );
      result.limitations = context.limitations;
      // Keep unsupported locations in the summary, but never invent inline anchors.
      if (
        result.findings.some(
          (finding) => !context.locations.get(finding.path)?.has(finding.line),
        )
      ) {
        result.partial = true;
        result.limitations.push(
          "Some findings have no valid added-line anchor and appear only in the summary.",
        );
      }
      await update({ status: "completed", result });
      hasResult = true;
    }
    // A repository may be disabled while analysis is in progress.
    const [stillEnabled] = await db
      .select()
      .from(reviewRepository)
      .where(
        and(
          eq(reviewRepository.repositoryId, run.repositoryId),
          eq(reviewRepository.installationId, run.installationId),
          eq(reviewRepository.enabled, true),
          isNotNull(reviewRepository.enabledBy),
        ),
      )
      .limit(1);
    if (!stillEnabled) throw new ReviewFailure("REPOSITORY_NOT_ENABLED");
    const published = await publishReview(
      client,
      run,
      result,
      settings.slug,
      context.locations,
    );
    await update({
      status: "completed",
      publicationStatus: "published",
      githubReviewId: published.id,
      githubReviewUrl: published.html_url,
      errorCode: null,
      leaseToken: null,
      leaseUntil: null,
    });
    return "done";
  } catch (error) {
    const failure =
      error instanceof ReviewFailure
        ? error
        : new ReviewFailure("REVIEW_INTERNAL_ERROR", true);
    if (failure.code === "REVIEW_LEASE_LOST") return "retry";
    const superseded = failure.code === "SUPERSEDED";
    const skipped = [
      "REPOSITORY_NOT_ENABLED",
      "PR_NOT_REVIEWABLE",
      "NO_REVIEWABLE_DIFF",
    ].includes(failure.code);
    const retry =
      failure.retryable && run.attempts < 4 && !superseded && !skipped;
    await update({
      status: superseded
        ? "superseded"
        : skipped
          ? "skipped"
          : hasResult
            ? "completed"
            : retry
              ? "queued"
              : "failed",
      publicationStatus:
        superseded || skipped
          ? "not_requested"
          : hasResult
            ? "failed"
            : "pending",
      attempts: retry || superseded || skipped ? run.attempts : 4,
      errorCode: failure.code,
      leaseToken: null,
      leaseUntil: null,
      dispatchedAt: retry ? null : new Date(),
    });
    console.error(
      JSON.stringify({
        event: "review_job_failed",
        runId,
        code: failure.code,
        retry,
      }),
    );
    return retry ? "retry" : "done";
  } finally {
    if (progress) {
      try {
        // Reactions are shared across commits of a PR. Preserve the indicator if
        // another commit/lease owner is still reviewing or publishing that PR.
        const [active] = await db
          .select({ id: reviewRun.id })
          .from(reviewRun)
          .where(
            and(
              eq(reviewRun.repositoryId, run.repositoryId),
              eq(reviewRun.pullNumber, run.pullNumber),
              sql`${reviewRun.leaseUntil} > now()`,
            ),
          )
          .limit(1);
        if (!active)
          await removeReviewEyes(
            progress.client,
            run.fullName,
            run.pullNumber,
            progress.reactionId,
          );
      } catch {
        // Cosmetic feedback must never fail an otherwise successful review.
        console.warn(
          JSON.stringify({
            event: "review_reaction_failed",
            runId,
            phase: "remove",
          }),
        );
      }
    }
  }
}

export async function repositoryRuns(
  db: Database,
  repositoryId: string,
  pullNumber?: number,
) {
  return db
    .select()
    .from(reviewRun)
    .where(
      and(
        eq(reviewRun.repositoryId, repositoryId),
        pullNumber === undefined
          ? undefined
          : eq(reviewRun.pullNumber, pullNumber),
      ),
    )
    .orderBy(desc(reviewRun.createdAt))
    .limit(30);
}
