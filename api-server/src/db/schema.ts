import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  boolean,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import type { ReviewResult } from "../lib/reviews/model";

export const reviewRepository = pgTable("review_repository", {
  repositoryId: text("repository_id").primaryKey(),
  installationId: text("installation_id").notNull(),
  fullName: text("full_name").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  enabledBy: text("enabled_by").references(() => user.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const reviewRun = pgTable(
  "review_run",
  {
    id: text("id").primaryKey(),
    installationId: text("installation_id").notNull(),
    repositoryId: text("repository_id").notNull(),
    fullName: text("full_name").notNull(),
    pullNumber: integer("pull_number").notNull(),
    headSha: text("head_sha").notNull(),
    status: text("status", {
      enum: [
        "queued",
        "reviewing",
        "completed",
        "failed",
        "superseded",
        "skipped",
      ],
    })
      .notNull()
      .default("queued"),
    publicationStatus: text("publication_status", {
      enum: ["pending", "published", "failed", "not_requested"],
    })
      .notNull()
      .default("pending"),
    result: jsonb("result").$type<ReviewResult>(),
    model: text("model").notNull(),
    attempts: integer("attempts").notNull().default(0),
    leaseToken: text("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    githubReviewId: text("github_review_id"),
    githubReviewUrl: text("github_review_url"),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("review_run_commit_unique").on(
      table.installationId,
      table.repositoryId,
      table.pullNumber,
      table.headSha,
    ),
    index("review_run_repository_created").on(
      table.repositoryId,
      table.createdAt,
    ),
    index("review_run_dispatch").on(table.status, table.dispatchedAt),
  ],
);

export const reviewDelivery = pgTable("review_delivery", {
  id: text("id").primaryKey(),
  payloadHash: text("payload_hash").notNull(),
  runId: text("run_id").references(() => reviewRun.id, {
    onDelete: "set null",
  }),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
