CREATE TABLE "review_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"payload_hash" text NOT NULL,
	"run_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_repository" (
	"repository_id" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"full_name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"enabled_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_run" (
	"id" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"full_name" text NOT NULL,
	"pull_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"publication_status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"model" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"github_review_id" text,
	"github_review_url" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_delivery" ADD CONSTRAINT "review_delivery_run_id_review_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."review_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_repository" ADD CONSTRAINT "review_repository_enabled_by_user_id_fk" FOREIGN KEY ("enabled_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_run_commit_unique" ON "review_run" USING btree ("installation_id","repository_id","pull_number","head_sha");--> statement-breakpoint
CREATE INDEX "review_run_repository_created" ON "review_run" USING btree ("repository_id","created_at");--> statement-breakpoint
CREATE INDEX "review_run_dispatch" ON "review_run" USING btree ("status","dispatched_at");