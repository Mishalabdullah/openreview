# Cloudflare deployments

The dashboard and API deploy to Cloudflare Workers. The frontend is static assets
only; the API also consumes review queues and runs outbox recovery every minute.
The landing-page application is not deployed by this workflow.

## Environments

| Git branch | GitHub environment | Frontend                    | API                             |
| ---------- | ------------------ | --------------------------- | ------------------------------- |
| `dev`      | `dev`              | `https://dev.openreview.si` | `https://api.dev.openreview.si` |
| `main`     | `production`       | `https://openreview.si`     | `https://api.openreview.si`     |

Production's apex domain serves the dashboard app. If the landing page already
uses `openreview.si`, decide where it will live before connecting this domain.
Moving the dashboard to another hostname requires updating both Wrangler configs,
`src/config/env.ts` in the API, frontend build scripts, workflow URLs, and GitHub
App URLs together.

## One-time setup (required before the first deployment)

These resources are **not** automatically provisioned by the repository setup.
Start with dev. Do not point dev at the production database or GitHub App.

### Cloudflare and PostgreSQL

1. Add `openreview.si` to the intended Cloudflare account and configure DNS.
   Resolve any existing Worker routes/DNS records that conflict with the four
   custom domains above. Wrangler attaches custom domains at deployment.
2. Use a Workers plan suitable for Queues and this workload; Workers
   Paid is the recommended production baseline. Review current usage pricing.
3. Create separate dev and production PostgreSQL databases (or isolated branches
   with separate credentials). Enable production backups/recovery. Scope each
   database role to its environment. The current workflow uses the same URL for
   runtime and migrations, so that role must also have migration permissions.
4. The API connects **directly to Railway PostgreSQL** through the `DATABASE_URL`
   Worker secret. In Railway, enable public TCP access for each database and use
   its public connection URL, not a `railway.internal` hostname. With PgBouncer,
   use the public unpooled URL. Configure TLS according to your database setup;
   do not bypass certificate validation. There is no shared connection proxy:
   each request/queue invocation owns a lazy pool capped at one connection,
   with timeouts and cleanup. Monitor total PostgreSQL connections as traffic
   grows; the cap is per invocation, not a global limit. Keep the existing
   bounded dashboard cache.
5. Create these queues before deploying:

   | Environment | Review queue                    | Dead-letter queue                   |
   | ----------- | ------------------------------- | ----------------------------------- |
   | dev         | `openreview-reviews-dev`        | `openreview-reviews-dev-dlq`        |
   | production  | `openreview-reviews-production` | `openreview-reviews-production-dlq` |

   Wrangler configures the producer, consumer, retry policy and dead-letter
   routing. Do not connect another Worker as consumer of the same review queue.
   Dead-letter queues intentionally have no consumer; monitor and investigate
   them rather than automatically replaying poison messages.

6. Create a Cloudflare API token scoped to the intended account and zone, with
   Worker deployment, custom-domain/route management, and Queues
   permissions appropriate for deployment. Use separate tokens for dev/prod
   where practical. Never use a global API key. Review the token permissions
   against Cloudflare's current deployment requirements.

### GitHub settings

In **Settings → Environments**, create `dev` and `production`.

- Restrict `dev` deployments to the `dev` branch.
- Restrict `production` deployments to the `main` branch.
- Add **required reviewers** for production and disallow self-approval where
  available. Approval is a GitHub setting, not something a workflow file can
  enforce. Check your repository visibility/plan supports this feature.
- Protect `main`: require pull requests and both `Check api-server` and
  `Check frontend` checks before merging. Protect workflow changes with review.

Set the following **in each GitHub environment**, not as shared repository values:

| Type     | Name                    | Value                                                                              |
| -------- | ----------------------- | ---------------------------------------------------------------------------------- |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Target Cloudflare account ID                                                       |
| Secret   | `CLOUDFLARE_API_TOKEN`  | Scoped deployment token                                                            |
| Secret   | `DATABASE_URL`          | Public Railway PostgreSQL URL for this environment, used by runtime and migrations |
| Secret   | `API_SECRETS_JSON`      | JSON object shown below, with real backend values                                  |
| Secret   | `GH_APP_PRIVATE_KEY`    | Full RSA PEM private key, with real line breaks (no quotes or JSON escaping)       |

```json
{
  "BETTER_AUTH_SECRET": "unique-random-secret-at-least-32-characters",
  "GITHUB_CLIENT_ID": "github-app-oauth-client-id",
  "GITHUB_CLIENT_SECRET": "github-app-oauth-client-secret",
  "GITHUB_WEBHOOK_SECRET": "unique-webhook-secret",
  "GITHUB_APP_SLUG": "your-environment-app-slug",
  "GITHUB_APP_ID": "123456",
  "OPENAI_API_KEY": "your-api-key"
}
```

Paste the private key separately into the GitHub secret `GH_APP_PRIVATE_KEY`, including the
BEGIN/END lines and real line breaks. Remove that key from `API_SECRETS_JSON`.
Existing JSON-only configurations remain supported; a separate non-empty key
takes precedence. Deployment preflight requires a valid RSA key.
GitHub reserves secret names starting with `GITHUB_`; the workflow maps
`GH_APP_PRIVATE_KEY` to the backend process variable `GITHUB_APP_PRIVATE_KEY`.
No secrets belong in `VITE_*` variables. Keep `BETTER_AUTH_SECRET`
stable: changing it invalidates sessions and can break decryption of stored
provider tokens. Use a different secret per environment.

The deploy script combines the seven JSON values, private key and database URL,
then validates and allowlists these nine backend secrets. It writes an ignored,
mode-0600 temporary secrets file, uploads it alongside the Worker code in one
deployment, then deletes the file. `DATABASE_URL` is now uploaded as a Worker
secret for direct database access. Cloudflare CI credentials are never uploaded.
Existing unrelated
Worker secrets are not removed by this additive upload.

### GitHub Apps

Use separate dev and production GitHub Apps, credentials, and installations.
Keep local testing on its own app, or deliberately switch the dev app's webhook
when testing locally—one app cannot simultaneously target local and hosted dev
using the single configured webhook URL.

| Setting        | Dev                                                      | Production                                           |
| -------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| OAuth callback | `https://api.dev.openreview.si/api/auth/callback/github` | `https://api.openreview.si/api/auth/callback/github` |
| Webhook        | `https://api.dev.openreview.si/api/v1/webhooks/github`   | `https://api.openreview.si/api/v1/webhooks/github`   |

Follow [GitHub setup](../api-server/docs/GITHUB_API.md) and
[review setup](../api-server/docs/CODE_REVIEWS.md) for the installation Setup URL,
permissions, and subscribed events. Install the dev app on test repositories only.
No ngrok tunnel is needed for hosted dev or production.

## Release flow

Workflow: [`.github/workflows/cloudflare.yml`](../.github/workflows/cloudflare.yml).

1. PRs into `dev` or `main` run both applications' formatting, tests, typechecks
   and builds. No deployment credentials are exposed to PR checks.
2. Pushes to `dev` deploy dev; pushes to `main` deploy production, after the
   configured environment approval. You can also use **Actions → Cloudflare
   CI/CD → Run workflow**, selecting `dev` or `main`. Other branches cannot deploy.
3. The deploy job validates configuration/secrets and builds the frontend with
   the correct API URL before changing the database.
4. Committed Drizzle migrations run against `DATABASE_URL` for that
   GitHub environment. Migrations are applied, not regenerated, in CI.
5. The API, review consumer, bindings, secrets and cron deploy together.
6. An API `/health` smoke check runs, then the frontend assets deploy and a
   `/dashboard` smoke check verifies SPA fallback.

Deployments are serialized per branch and running deployments are not cancelled
by newer pushes. A stale branch-head check rejects outdated queued releases before
they change resources. Dev and production can deploy independently. Frontend builds
are environment-specific because Vite bakes `VITE_API_URL` into browser assets.
There is no automatic deployment of arbitrary PR previews.

Migrations and the two Workers are **not an atomic release**. Use additive,
backward-compatible migrations and API contracts. If the frontend deployment
fails after the API succeeds, repair/re-run the deployment. A later failed
step does not undo earlier successful migrations or Worker deployments.

## First-release verification

Before promoting dev to production:

- Confirm GitHub webhook `ping` returns 200 and reviewable PR events return 202.
- Sign in with GitHub; refresh a nested dashboard URL; verify sign-out.
- Open a small PR in an installed test repository. Verify automatic review,
  saved dashboard history, 👀, and the published review.
- Check the once-per-minute recovery cron and Queue consumer in Cloudflare.
- Check logs and dead-letter queues; investigate database disconnects.
- Configure monitoring and AI usage limits/alerts. The `/health` smoke test
  checks HTTP availability only, not PostgreSQL, OAuth, queues, or OpenAI.
- Do not put browser-challenge/auth middleware in front of the webhook path:
  GitHub authenticates through the verified webhook HMAC, not a browser session.

## Local commands and rollback

Local `npm run dev` remains unchanged and uses local queue simulation. It does
not deploy; it reads the local/development `DATABASE_URL`.

For a manual API deployment, set the selected environment's `DATABASE_URL`,
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `API_SECRETS_JSON`, and
`GITHUB_APP_PRIVATE_KEY` securely in
the process environment, then run `npm run deploy:dev` or `npm run deploy:prod`
inside `api-server`. These commands do **not** run database migrations; use the
protected workflow for normal releases. A bare `npm run deploy` is refused.

Offline API packaging checks, without uploading or reading local secrets:

```sh
npm run deploy:dev -- --dry-run
npm run deploy:prod -- --dry-run
```

Successful packaging does not verify real resources, database connectivity, or
permissions. Dry runs do not need credentials or a database URL.

Frontend commands are `npm run deploy:dev` and `npm run deploy:prod` from
`frontend`; they rebuild for the correct API before deploying. Do not run these
until the intended account, domains and credentials are configured.

For rollback, prefer reverting the offending code commit through the normal
protected release flow. Emergency Worker rollback is also possible in Cloudflare,
but it does **not** roll back the database or connected queues. Keep API/frontend
versions compatible and review migration effects before reverting code.

References: [Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/),
[static SPA assets](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/),
[deploying secrets with code](https://developers.cloudflare.com/workers/configuration/secrets/#upload-secrets-alongside-code).
