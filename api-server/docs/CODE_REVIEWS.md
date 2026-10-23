# Automatic code reviews

Implemented flow:

```text
GitHub webhook → HMAC verification → delivery + job transaction → Cloudflare Queue
→ installation token → live repo/PR/SHA checks → bounded OpenAI review
→ save findings → reconcile/post GitHub COMMENT review → dashboard
```

**Reviews are on by default.** Once credentials, database and queue are
configured, every non-draft PR event under an installed GitHub App starts a
review automatically—no global flag and no per-repository enable step. A
repository administrator can turn reviews **off** for a repository from its
Pull Requests page; that is the manual action. This default-on change requires
no additional database migration. No
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
- Issues: Read & write — required for the 👀 progress reaction on the PR
  description. Reviews still publish without it, but the indicator is skipped
  and a limitation is noted in the published review.
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
delivery alone is not treated as the source of truth. Local dev does not
automatically emulate the production cron schedule, so `npm run dev` includes
`--test-scheduled`: run
`curl "http://localhost:1337/__scheduled?cron=*+*+*+*+*"` to trigger recovery
dispatch on demand. This also recovers runs interrupted by a dev-server
restart, which otherwise sit queued because local cron timers and in-memory
queue messages do not survive restarts.

### 5. Configure the webhook

Keep ngrok forwarding to **port 1337** while testing. In GitHub App settings use:

```text
https://YOUR-TUNNEL/api/v1/webhooks/github
```

Configure the same webhook secret as the backend, JSON content type, and Pull
request events. Installation and installation-repository removal/suspension
events disable affected repositories, including previously unmanaged ones (a
saved disable row overrides the enabled-by-default policy). Keep the OAuth
callback and app installation Setup URL separate from this webhook URL.

Raw payloads are bounded to 1 MiB and verified before JSON parsing. OpenReview
login cookies are not required for webhooks; the HMAC authenticates them. Invalid
signatures are rejected. `ping` is supported. Review jobs are triggered only for
`opened`, `synchronize`, `reopened`, and `ready_for_review`, for open non-draft PRs.

The HTTP response is sent only after the delivery/job transaction commits and
queue dispatch is attempted. If dispatch fails, HTTP 503 is returned but the job
remains recoverable by the scheduled dispatcher. GitHub does **not** automatically
redeliver every failed webhook, so keep recovery scheduling configured.

#### If reviews only start after clicking "Request / retry review"

GitHub webhook deliveries are not reaching the backend (a manually requested
run creates no `review_delivery` row). Check, in order:

1. **Current tunnel host**: free ngrok URLs change on every restart. Update the
   GitHub App webhook URL whenever ngrok restarts.
2. **Matching secret**: the webhook secret saved in the GitHub App must equal
   `GITHUB_WEBHOOK_SECRET`. A mismatch returns `401 INVALID_WEBHOOK_SIGNATURE`
   and records nothing. Use the app's **Advanced → Recent deliveries →
   Redeliver** after fixing configuration and expect **202** (200 for `ping`).
3. **Subscribed events**: "Pull requests" must be selected (optionally
   "Installation" events for disable handling).
4. Stale log lines such as `501 Not Implemented` or `404` for
   `/api/v1/webhooks/github` come from dev servers that ran the old reserved
   stub; the implemented handler never returns 501.

A saved webhook sends GitHub's `ping` delivery automatically: a 200 response
there confirms the URL and secret without creating any review.

### 6. Verify and test

1. Sign in and select a repository on the dashboard's Pull Requests page.
   Restart the backend after completing the credentials, migration and queue setup.
2. Reviews already run by default—there is no enable step. A repository
   administrator can click **Disable reviews** to stop them for that repository,
   and re-enable later.
3. Open a small non-draft PR or push a commit to one.
4. Inspect GitHub App Recent deliveries: expect 202 for a reviewable PR event.
5. Expand **OpenReview** on the PR card. It polls while a run is active, for up to
   five minutes; Refresh status can resume checking.
6. Verify saved findings and **View on GitHub** after publication.

Reviews are not backfilled for PRs that predate setup. For an existing open
non-draft PR, use **Request / retry review**; repository write access is
required. Automatic reviews work without a browser session. Repositories an
administrator disabled are ignored, and manual requests for them return
`REVIEWS_NOT_ENABLED` until re-enabled.

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

`GET .../reviews/settings` returns `enabled: true` when the repository has no
saved choice (the default) and `available: false` while backend credentials are
incomplete. `POST` accepts `{ "enabled": true|false }` from a repository
administrator to disable or re-enable a repository. `REVIEWS_NOT_ENABLED` (409)
means an administrator disabled it.

`appReview` on PR lists/overview includes saved runs. Progress and overview metrics
are read from PostgreSQL **after** loading cached GitHub data; the 30-second GitHub
cache does not freeze review status. History/settings do not use the response
cache. GitHub access reads can still use the approved 30-second upstream cache;
mutations and the background review/publish path bypass it.

Errors use the existing structured envelope. Additional codes include
`REVIEWS_NOT_CONFIGURED`, `REVIEW_QUEUE_UNAVAILABLE`, `REVIEWS_NOT_ENABLED`,
`REVIEW_ADMIN_REQUIRED`, `REVIEW_WRITE_REQUIRED`, and `PR_NOT_REVIEWABLE`.

## Reliability and safety

- The app adds **👀 to the PR's opening description as the first action of a
  review job**, before any diff fetching or model analysis, so authors
  immediately see the review is underway. GitHub treats that description as an
  issue body, so this does not create a comment or react to an arbitrary
  discussion reply. GitHub reuses an existing eyes reaction from the same bot.
  The 👀 is an **in-progress indicator only**: cleanup removes the returned bot
  reaction when the attempt ends (the review itself remains posted), unless
  another review lease for that PR remains active. Reactions require the
  GitHub App **Issues: Read & write** permission; without it the reaction is
  skipped, the review still completes, and the published review notes the
  missing indicator. Reaction failures never fail the review itself, and
  network failures/crashes can temporarily leave an indicator behind.

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

Disposable PGlite tests cover migrations, enabled-by-default reviews,
administrator opt-out, HMAC verification,
delivery/commit deduplication, queue-send recovery, review generation, publication,
ambiguous POST reconciliation, old commits/drafts/revoked access, suspension,
removed repositories, leases, invalid inline locations, model failures, and
cache-fresh dashboard data.
Workers-runtime tests exercise real RSA JWT signing/token exchange with a mock
transport. These tests do not verify your live keys, billing, installed permissions,
ngrok availability, remote queue bindings, or a real GitHub publication.
