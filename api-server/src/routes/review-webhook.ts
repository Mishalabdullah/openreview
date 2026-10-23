import { Hono } from "hono";
import { z } from "zod";
import { and, eq, isNotNull } from "drizzle-orm";
import type { AppEnv } from "../types/env";
import { reviewDelivery, reviewRepository, reviewRun } from "../db/schema";
import { ApiError } from "../lib/api-error";
import { id } from "../lib/github/schemas";
import { fingerprint } from "../lib/github/pagination";
import { enqueueRun, type ReviewQueue } from "../lib/reviews/jobs";
import { reviewConfig } from "../lib/reviews/config";

const event = z.object({
  action: z.string(),
  installation: z.object({ id }),
  repository: z.object({
    id,
    full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  }),
  pull_request: z.object({
    number: z.number().int().positive(),
    state: z.string(),
    draft: z.boolean().optional(),
    head: z.object({ sha: z.string().regex(/^[a-f0-9]{40,64}$/i) }),
  }),
});

export async function verifyWebhook(
  secret: string,
  signature: string | undefined,
  body: Uint8Array,
) {
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const bytes = Uint8Array.from(signature.slice(7).match(/../g)!, (part) =>
    parseInt(part, 16),
  );
  return crypto.subtle.verify("HMAC", key, bytes, body);
}

export function reviewWebhook(
  queue: (env: AppEnv["Bindings"]) => ReviewQueue | undefined = (env) =>
    env.REVIEW_QUEUE,
) {
  const routes = new Hono<AppEnv>();
  routes.post("/webhooks/github", async (c) => {
    // Read a bounded raw body. Signature verification must precede JSON parsing.
    const reader = c.req.raw.body?.getReader();
    if (!reader)
      throw new ApiError(400, "INVALID_WEBHOOK", "Missing webhook body.");
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const value = await reader.read();
        if (value.done) break;
        length += value.value.length;
        if (length > 1024 * 1024) {
          await reader.cancel();
          throw new ApiError(
            413,
            "WEBHOOK_TOO_LARGE",
            "Webhook payload exceeds the limit.",
          );
        }
        chunks.push(value.value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    if (
      !(await verifyWebhook(
        c.var.config.GITHUB_WEBHOOK_SECRET,
        c.req.header("X-Hub-Signature-256"),
        body,
      ))
    )
      throw new ApiError(
        401,
        "INVALID_WEBHOOK_SIGNATURE",
        "Invalid webhook signature.",
      );
    const deliveryId = z
      .string()
      .uuid()
      .safeParse(c.req.header("X-GitHub-Delivery"));
    if (!deliveryId.success)
      throw new ApiError(400, "INVALID_WEBHOOK", "Invalid delivery ID.");
    const kind = c.req.header("X-GitHub-Event");
    if (kind === "ping") return c.json({ accepted: true });
    const settings = reviewConfig(c.var.config);
    const producer = queue(c.env);
    if (!producer)
      throw new ApiError(
        503,
        "REVIEW_QUEUE_UNAVAILABLE",
        "Review queue is not configured.",
      );
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new ApiError(400, "INVALID_WEBHOOK", "Invalid webhook JSON.");
    }
    // Revocations disable opt-ins. Consumers also check live installation/repo access.
    if (kind === "installation" || kind === "installation_repositories") {
      const parsed = z
        .object({
          action: z.string(),
          installation: z.object({ id }),
          repositories_removed: z.array(z.object({ id })).optional(),
        })
        .safeParse(payload);
      if (!parsed.success)
        throw new ApiError(
          400,
          "INVALID_WEBHOOK",
          "Invalid installation event.",
        );
      if (["deleted", "suspend"].includes(parsed.data.action))
        await c.var.db
          .update(reviewRepository)
          .set({ enabled: false, updatedAt: new Date() })
          .where(
            eq(reviewRepository.installationId, parsed.data.installation.id),
          );
      for (const repo of parsed.data.repositories_removed ?? [])
        await c.var.db
          .update(reviewRepository)
          .set({ enabled: false, updatedAt: new Date() })
          .where(
            and(
              eq(reviewRepository.repositoryId, repo.id),
              eq(reviewRepository.installationId, parsed.data.installation.id),
            ),
          );
      return c.json({ accepted: true });
    }
    if (kind !== "pull_request")
      return c.json({ accepted: true, ignored: true });
    const parsed = event.safeParse(payload);
    if (!parsed.success)
      throw new ApiError(400, "INVALID_WEBHOOK", "Invalid pull request event.");
    const value = parsed.data;
    if (
      !["opened", "synchronize", "reopened", "ready_for_review"].includes(
        value.action,
      ) ||
      value.pull_request.draft ||
      value.pull_request.state !== "open"
    )
      return c.json({ accepted: true, ignored: true });
    const payloadHash = await fingerprint(new TextDecoder().decode(body));
    const runId = await c.var.db.transaction(async (tx) => {
      const [claimed] = await tx
        .insert(reviewDelivery)
        .values({ id: deliveryId.data, payloadHash })
        .onConflictDoNothing()
        .returning();
      if (!claimed) {
        const [previous] = await tx
          .select()
          .from(reviewDelivery)
          .where(eq(reviewDelivery.id, deliveryId.data))
          .limit(1);
        if (previous.payloadHash !== payloadHash)
          throw new ApiError(
            409,
            "WEBHOOK_DELIVERY_CONFLICT",
            "Delivery ID was already used.",
          );
        return previous.runId;
      }
      const [enabled] = await tx
        .select()
        .from(reviewRepository)
        .where(
          and(
            eq(reviewRepository.repositoryId, value.repository.id),
            eq(reviewRepository.installationId, value.installation.id),
            eq(reviewRepository.enabled, true),
            isNotNull(reviewRepository.enabledBy),
          ),
        )
        .limit(1);
      let runId: string | null = null;
      if (enabled) {
        await tx
          .insert(reviewRun)
          .values({
            id: crypto.randomUUID(),
            repositoryId: value.repository.id,
            installationId: value.installation.id,
            fullName: value.repository.full_name,
            pullNumber: value.pull_request.number,
            headSha: value.pull_request.head.sha,
            model: settings.model,
          })
          .onConflictDoNothing();
        const [run] = await tx
          .select()
          .from(reviewRun)
          .where(
            and(
              eq(reviewRun.repositoryId, value.repository.id),
              eq(reviewRun.installationId, value.installation.id),
              eq(reviewRun.pullNumber, value.pull_request.number),
              eq(reviewRun.headSha, value.pull_request.head.sha),
            ),
          )
          .limit(1);
        if (run.status === "skipped" || run.status === "superseded") {
          await tx
            .update(reviewRun)
            .set({
              status: run.result ? "completed" : "queued",
              publicationStatus: "pending",
              attempts: 0,
              errorCode: null,
              leaseToken: null,
              leaseUntil: null,
              dispatchedAt: null,
              updatedAt: new Date(),
            })
            .where(
              and(eq(reviewRun.id, run.id), eq(reviewRun.status, run.status)),
            );
        }
        runId = run.id;
      }
      await tx
        .update(reviewDelivery)
        .set({ runId })
        .where(eq(reviewDelivery.id, deliveryId.data));
      return runId;
    });
    if (runId) {
      try {
        await enqueueRun(c.var.db, producer, runId);
      } catch {
        throw new ApiError(
          503,
          "REVIEW_QUEUE_UNAVAILABLE",
          "Review is saved and awaiting queue dispatch.",
        );
      }
    }
    return c.json({ accepted: true, runId, ignored: !runId }, 202);
  });
  return routes;
}
