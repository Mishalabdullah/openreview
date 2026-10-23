import { z } from "zod";
import { readConfig } from "./config/env";
import { createDatabase } from "./db";
import type { Bindings } from "./types/env";
import { hasReviewCredentials } from "./lib/reviews/config";
import {
  dispatchPending,
  processReview,
  type ReviewMessage,
} from "./lib/reviews/jobs";

export const reviewWorker = {
  async queue(batch: MessageBatch<ReviewMessage>, env: Bindings) {
    const config = readConfig(env);
    if (!hasReviewCredentials(config)) {
      batch.retryAll({ delaySeconds: 300 });
      return;
    }
    const resource = createDatabase(env);
    try {
      for (const message of batch.messages) {
        const body = z
          .object({ runId: z.string().uuid() })
          .safeParse(message.body);
        if (!body.success) {
          message.ack();
          continue;
        }
        try {
          if (
            (await processReview(resource.db, config, body.data.runId)) ===
            "retry"
          )
            message.retry({ delaySeconds: 60 });
          else message.ack();
        } catch {
          console.error(
            JSON.stringify({
              event: "review_consumer_failed",
              runId: body.data.runId,
            }),
          );
          message.retry({ delaySeconds: 60 });
        }
      }
    } finally {
      await resource.close();
    }
  },
  async scheduled(_controller: ScheduledController, env: Bindings) {
    const config = readConfig(env);
    if (!hasReviewCredentials(config) || !env.REVIEW_QUEUE) return;
    const resource = createDatabase(env);
    try {
      await dispatchPending(resource.db, env.REVIEW_QUEUE);
    } catch {
      console.error(JSON.stringify({ event: "review_dispatch_failed" }));
      throw new Error("Review dispatch failed");
    } finally {
      await resource.close();
    }
  },
};
