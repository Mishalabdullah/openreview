# Automatic code reviews

Implemented flow:

```text
GitHub webhook → HMAC verification → delivery + job transaction → Cloudflare Queue
→ installation token → live repo/PR/SHA checks → bounded OpenAI review
→ save findings → reconcile/post GitHub COMMENT review → dashboard
```

**Repositories require administrator opt-in.** Once credentials, database and queue
are configured, no global enable flag is required. No
live GitHub review or OpenAI request was made while implementing/testing it. No
migration was applied to your configured database, and no remote queue was created.

## Setup checklist

### 1. Configure secrets locally

Use the ignored `.env` or `.dev.vars` file that Wrangler actually loads. If
`.dev.vars` exists, Wrangler uses it instead of `.env`; keep related secrets in
the same effective file. Never commit the real values.

```dotenv
OPENAI_API_KEY=...
OPENAI_REVIEW_MODEL=gpt-5-mini
GITHUB_APP_ID=...
GITHUB_APP_SLUG=...
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=...
```

`OPEN_AI_KEY` is supported as a compatibility alias; `OPENAI_API_KEY` takes
precedence. The model must be available to your OpenAI API project and support
Responses API structured outputs. Enable API billing and configure a project
spending limit. A ChatGPT subscription does not supply API credits.

The App ID and downloaded private key are **not** the OAuth client ID/secret.
PKCS1 RSA and PKCS8 private keys are normalized before signing the GitHub App JWT.
Background reviews use short-lived **installation access tokens**, not a user's
login token. Deployed environments need separately installed Worker secrets.

### 2. Approve GitHub App permissions

- Metadata: Read-only
- Contents: Read-only
- Pull requests: Read & write
- Account email read permission remains needed for login.

Existing installation owners must approve changed permissions. Checks permission
is not needed: this implementation publishes PR reviews, not Check Runs. It never
automatically approves, requests changes, merges, or executes PR code.

### 3. Apply the application migration to an approved database

Generated migration: `drizzle/0001_married_lightspeed.sql`.

It adds `review_repository`, `review_run`, and `review_delivery`. Verify the
database target is the intended non-production database before running the
existing `npm run db:migrate` command. Do not assume a connection string is local
based on the rest of the application running on your laptop. If your tooling
loads `.dev.vars`, ensure that file selects the approved database. Do not run
schema generation against the live database as a substitute for migration.

### 4. Run the local queue producer and consumer

`wrangler.jsonc` includes local simulation for `openreview-reviews-local`, with a
batch size of one, concurrency capped at two, five queue retries and a dead-letter
queue. `npm run dev` runs the HTTP API and queue consumer together. No external
queue resource is needed for this local simulation.

Production/dev environment bindings are deliberately **not** provisioned by this
change. Before deploying reviews, explicitly create/select environment-specific
queues and add producers/consumers with binding name `REVIEW_QUEUE` to each
environment. Configure a once-per-minute Cron Trigger for recovery dispatch.
Do not accidentally deploy the local queue names as production resources.

The scheduled handler recovers saved-but-unsent jobs and expired leases; queue
delivery alone is not treated as the source of truth. Local Cron Triggers must be
invoked using Wrangler's scheduled-event testing support; local dev does not
automatically emulate the production cron schedule.

### 5. Configure the webhook

Keep ngrok forwarding to **port 1337** while testing. In GitHub App settings use:

```text
https://YOUR-TUNNEL/api/v1/webhooks/github
```

Configure the same webhook secret as the backend, JSON content type, and Pull
request events. Installation and installation-repository removal/suspension
events disable affected repository opt-ins. Keep the OAuth callback and app
installation Setup URL separate from this webhook URL.

Raw payloads are bounded to 1 MiB and verified before JSON parsing. OpenReview
login cookies are not required for webhooks; the HMAC authenticates them. Invalid
signatures are rejected. `ping` is supported. Review jobs are triggered only for
`opened`, `synchronize`, `reopened`, and `ready_for_review`, for open non-draft PRs.

The HTTP response is sent only after the delivery/job transaction commits and
queue dispatch is attempted. If dispatch fails, HTTP 503 is returned but the job
remains recoverable by the scheduled dispatcher. GitHub does **not** automatically
redeliver every failed webhook, so keep recovery scheduling configured.

### 6. Opt in and test

1. Sign in and select a repository on the dashboard's Pull Requests page.
   Restart the backend after completing the credentials, migration and queue setup.
2. As a repository administrator, click **Enable reviews**. This consents to
   sending PR source context to OpenAI and publishing informational bot reviews.
3. Open a small non-draft PR or push a commit to one.
4. Inspect GitHub App Recent deliveries: expect 202 for a reviewable PR event.
5. Expand **OpenReview** on the PR card. It polls while a run is active, for up to
   five minutes; Refresh status can resume checking.
6. Verify saved findings and **View on GitHub** after publication.

Enabling reviews does not backfill existing PRs. For an existing open non-draft
PR, use **Request / retry review**; repository write access is required. Automatic
reviews work without a browser session after opt-in. Repositories without admin
opt-in are ignored, even if the app is installed there.

## API contract

All dashboard endpoints require a Better Auth cookie and accessible app-installed
repository. Their results are private/no-store. Mutations use fresh GitHub checks.

```text
GET  /api/v1/repositories/:repositoryId/reviews/settings
POST /api/v1/repositories/:repositoryId/reviews/settings { "enabled": true|false }
GET  /api/v1/repositories/:repositoryId/pull-requests/:number/reviews
POST /api/v1/repositories/:repositoryId/pull-requests/:number/reviews
```

History returns `{ data: ReviewRun[], available: boolean }`, newest first, at most
30 runs. A run contains string IDs, PR number, head SHA, model, timestamps, result,
error code, GitHub review URL, `status` and **separate** `publicationStatus`.

Run statuses: `queued`, `reviewing`, `completed`, `failed`, `superseded`, `skipped`.
Publication statuses: `pending`, `published`, `failed`, `not_requested`.

The result contains `summary`, `findings`, `partial` and `limitations`. Findings
contain `path`, new-side `line`, `severity`, `title`, and `description`.

`appReview` on PR lists/overview includes saved runs. Progress and overview metrics
are read from PostgreSQL **after** loading cached GitHub data; the 30-second GitHub
cache does not freeze review status. History/settings do not use the response
cache. GitHub access reads can still use the approved 30-second upstream cache;
mutations and the background review/publish path bypass it.

Errors use the existing structured envelope. Additional codes include
`REVIEWS_NOT_CONFIGURED`, `REVIEW_QUEUE_UNAVAILABLE`, `REVIEWS_NOT_ENABLED`,
`REVIEW_ADMIN_REQUIRED`, `REVIEW_WRITE_REQUIRED`, and `PR_NOT_REVIEWABLE`.

## Reliability and safety

- The app adds **👀 to the PR's opening description** when a validated review
  attempt begins analysis. GitHub treats that description as an issue body, so
  this does not create a comment or react to an arbitrary discussion reply.
  GitHub reuses an existing eyes reaction from the same bot. Cleanup removes the
  returned bot reaction when the attempt ends, unless another review lease for
  that PR remains active. Reaction failures are logged without failing the review;
  network failures/crashes can temporarily leave an indicator behind. No live
  reactions were added while implementing this feature.

- Jobs are unique per installation/repository/PR/head SHA. Redeliveries do not
  create another analysis for that commit. Changing models alone does not rerun it.
- PostgreSQL leases prevent simultaneous processing. Queue retries and scheduled
  recovery handle interruption. At most four claimed attempts occur before a
  terminal failure; an authorized manual retry resets this budget.
- Generated findings are saved **before** publishing. Publication retries reuse
  them rather than calling OpenAI again.
- Publishing scans up to 1,000 existing reviews for an app-bot marker tied to the
  job and SHA. This reconciles ambiguous POST failures. GitHub and PostgreSQL do
  not share an atomic transaction: this minimizes duplicates, not a mathematical
  exactly-once guarantee for external side effects.
- Check the PR's current head before analysis and immediately before publishing.
  Older runs become superseded. Every posted review includes the exact commit
  SHA; a concurrent push during POST can still make it an older-commit review.
- Only validated added-line anchors receive inline comments. Unsupported anchors
  are shown in the summary with an explicit limitation.
- Bounds: 100 changed files, 90,000 input characters across patches/source,
  up to five source files of at most 20,000 bytes each, 12 findings, 6,000 model
  output tokens, a 90-second OpenAI timeout, and 40 installation API calls per
  attempt. GitHub bodies are capped at 2 MiB. Large/truncated/missing diffs are
  never presented as a guarantee of complete coverage.
- Obvious secret/key paths (`.env*`, PEM/private-key containers, SSH private keys)
  are excluded from model input. This is not a general-purpose secret detector:
  never commit secrets in ordinary source files either.
- Model output is schema-validated. Repository content is untrusted data, not
  instructions. No tool execution, shell, link fetching, automatic approval or
  test execution is performed. No secrets/provider bodies are logged.
- Review data can quote private source. It remains in the existing PostgreSQL
  database and is only exposed through repository-authorized endpoints. No raw
  webhook payload or full diff is persisted. Configure retention/backups according
  to your data policy; automatic historical review deletion is not included.

## Verification performed

Disposable PGlite tests cover migrations, authenticated opt-in, HMAC verification,
delivery/commit deduplication, queue-send recovery, review generation, publication,
ambiguous POST reconciliation, old commits/drafts/revoked access, suspension,
leases, invalid inline locations, model failures, and cache-fresh dashboard data.
Workers-runtime tests exercise real RSA JWT signing/token exchange with a mock
transport. These tests do not verify your live keys, billing, installed permissions,
ngrok availability, remote queue bindings, or a real GitHub publication.
