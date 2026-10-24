# OpenReview

**Less back-and-forth. More forward.**

OpenReview is an open-source, AI-assisted code review platform for GitHub pull requests. It brings accessible repositories, PR activity, review progress, and findings into one workspace, and can publish review feedback directly on GitHub.

Code review often slows teams down: reviewers have limited time, context is scattered, and routine checks compete with deeper design decisions. OpenReview provides a first pass over changes so developers can spend more time on the feedback that needs human judgment. It assists reviewers—it does not replace them or automatically approve or merge code.

## Product demo

**[Watch the prototype demo on YouTube](https://www.youtube.com/watch?v=r4pk2VYXTKE)** · **[Open the hosted app](https://app.openreview.si/)** · **[Visit the website](https://openreview.si/)**

[![Watch the OpenReview prototype demo](https://img.youtube.com/vi/r4pk2VYXTKE/maxresdefault.jpg)](https://www.youtube.com/watch?v=r4pk2VYXTKE)

The dashboard is at [app.openreview.si/dashboard](https://app.openreview.si/dashboard). Sign in with GitHub and install the GitHub App for the repositories you want to connect. Organization installations may require owner approval.

## The idea

- **Review where developers already work.** Connect GitHub repositories, browse PRs, and publish findings back to the pull request.
- **Make feedback actionable.** Surface a summary and file-/line-specific findings, with severity and explanations.
- **Keep teams in control.** Let repository administrators disable automatic reviews, support manual review requests, and make failures and limitations visible.
- **Build toward specialized reviewers.** Explore commit-type routing, such as `feat:` to a feature reviewer and `security:` to a security reviewer, without hiding which configuration is still a prototype.
- **Stay open by design.** Keep the implementation inspectable, self-hostable, and community-driven.

## What is implemented

| Area              | Current implementation                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Authentication    | GitHub sign-in through Better Auth, cookie-based sessions, protected dashboard routes, and sign-out                           |
| Repository access | GitHub App installation/reconnection, accessible repository browsing, search, filters, and cursor pagination                  |
| Pull requests     | Combined or repository-specific browsing, state/draft filters, sorting, and pagination                                        |
| Overview          | Repository and open-PR counts, recent pull requests, and saved review activity; unavailable values remain explicit            |
| AI reviews        | Verified webhooks, durable review jobs, queued OpenAI analysis, saved findings, GitHub comment reviews, and dashboard results |
| Review controls   | Review history/status, manual request/retry, and an administrator-controlled per-repository review switch                     |
| Settings          | Session profile, GitHub connection management, persistent light/dark preference, and direct logout                            |
| Models & Agents   | Browser-local configuration drafts, multiple agents, commit-type/model assignments, fallback selection, and a routing preview |
| Review Rules      | Illustrated guidance and copyable Markdown examples for a root `.review/` folder                                              |
| Public website    | Astro landing page, journal, RSS, manifesto, brand assets, and an illustrative review workspace                               |

### Prototype boundaries

- **AI reviews require backend setup:** GitHub App permissions, credentials, PostgreSQL migrations, an OpenAI API key, and queue configuration. Once configured, automatic reviews are on by default for installed repositories unless an administrator disables them. Existing PRs can be reviewed manually; they are not automatically backfilled.
- **Model routing is a local draft, not live execution configuration.** The Models & Agents page does not provision models or change the backend review model. The running review service uses its server-configured OpenAI model.
- **Custom rules are currently a setup guide.** The Review Rules page explains how to organize `.review/rule_1.md` and `.review/security.md`; it does not yet load those files into AI reviews.
- **GitHub login and installation are separate.** Repository lists include only repositories accessible to both the signed-in user and the GitHub App installation.
- **The landing-page workspace is illustrative.** Use the hosted application for the actual dashboard. AI review coverage is bounded; findings and any partial-analysis limitations still need human review.

## Technology stack

| Layer                | Technologies and purpose                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| Dashboard            | **SolidJS, Vite, TypeScript**, shared CSS, and **Lucide Solid** icons                                       |
| Website              | **Astro**, Markdown/MDX, RSS, and sitemap generation                                                        |
| API                  | **Hono** on **Cloudflare Workers**, with **Zod** validation                                                 |
| Authentication       | **Better Auth** with GitHub OAuth, sessions, and organization/team support                                  |
| Persistence          | **PostgreSQL**, **Drizzle ORM**, and SQL migrations                                                         |
| Review processing    | **Cloudflare Queues**, scheduled recovery, GitHub App installation tokens, and the **OpenAI Responses API** |
| Hosting and delivery | **Cloudflare Workers Static Assets**, Wrangler, and GitHub Actions for dashboard/API CI/CD                  |
| Quality checks       | **Vitest**, PGlite-backed integration tests, Workers runtime tests, TypeScript checks, and Prettier         |
| Typography           | Self-hosted Manrope, Newsreader, and IBM Plex Mono                                                          |

### Review workflow

```text
GitHub PR event
  → verify webhook signature
  → persist delivery and review job in PostgreSQL
  → dispatch through Cloudflare Queues
  → check repository access and current PR commit
  → analyze a bounded diff with OpenAI
  → save findings and publish a GitHub COMMENT review
  → display results and publication status in the dashboard
```

Background reviews use short-lived GitHub App installation tokens. Provider tokens and API keys stay on the backend. The review worker does not execute pull-request code or automatically approve, request changes, or merge a PR. See the [code review documentation](api-server/docs/CODE_REVIEWS.md) for permissions, limits, failure handling, and setup.

## Repository structure

```text
openreview/
├── frontend/        # SolidJS dashboard, authentication, and review UI
├── api-server/      # Hono Worker, auth, GitHub APIs, and review processing
│   ├── src/         # Routes, services, database schema, and queue handlers
│   ├── drizzle/     # SQL migrations
│   ├── docs/        # GitHub API and automatic review contracts
│   └── test/        # Backend integration and Workers tests
├── landing-page/    # Astro website, journal, manifesto, and brand identity
├── docs/            # Deployment instructions and architecture notes
├── .github/         # Dashboard/API CI/CD workflows
├── LICENSE
└── README.md
```

Each application has its own dependencies, scripts, and setup documentation; run commands for the relevant package rather than assuming a root npm workspace.

## Getting started

### Requirements

- **Node.js 24 LTS** is recommended for the full platform. The website requires at least Node.js 22.22.0.
- npm
- A development PostgreSQL database and a configured GitHub App for local authenticated use
- An OpenAI API key and review permissions for AI review execution

### Run the dashboard and API locally

Install dependencies and copy the example configuration files:

```sh
npm --prefix api-server ci
npm --prefix frontend ci
cp api-server/.dev.vars.example api-server/.dev.vars
cp frontend/.env.example frontend/.env
```

Configure the backend's `.dev.vars` using the [API setup guide](api-server/README.md). Use a confirmed local/development database, set the GitHub App credentials and auth secret, and follow the [review setup checklist](api-server/docs/CODE_REVIEWS.md) if you want AI reviews. Apply the documented migrations only after verifying the database target.

The frontend's public API setting is:

```dotenv
VITE_API_URL=http://localhost:1337
```

Start each service in a separate terminal:

```sh
npm --prefix api-server run dev
```

```sh
npm --prefix frontend run dev
```

Open **http://localhost:5173**. The API runs at **http://localhost:1337**. Use `localhost` consistently; mixing it with `127.0.0.1` can break cookie-based authentication. Never expose backend credentials in `VITE_*` variables.

### Run the website

From the repository root:

```sh
npm --prefix landing-page ci
npm --prefix landing-page run dev -- --background
```

Open **http://localhost:4321**.

Manage the background development server:

```sh
npm --prefix landing-page run astro -- dev status
npm --prefix landing-page run astro -- dev logs
npm --prefix landing-page run astro -- dev stop
```

### Checks and builds

```sh
npm --prefix frontend run typecheck
npm --prefix frontend test
npm --prefix frontend run build
npm --prefix frontend run format:check

npm --prefix api-server run typecheck
npm --prefix api-server test
npm --prefix api-server run build

npm --prefix landing-page run check
npm --prefix landing-page run build
```

Dashboard and website builds are generated in their respective `dist/` directories. The API build is a packaging dry run, not a deployment. Automated tests do not establish that a live GitHub installation, database, or OpenAI account is configured correctly.

## Deployment and documentation

The dashboard and API share a Cloudflare CI/CD workflow: `dev` targets hosted development and `main` targets production. Databases, queues, GitHub Apps, and secrets are isolated by environment. The landing page is deployed separately.

- [Deployment and environment setup](docs/DEPLOYMENT.md)
- [Dashboard setup and behavior](frontend/README.md)
- [API, authentication, and database setup](api-server/README.md)
- [GitHub dashboard API contract](api-server/docs/GITHUB_API.md)
- [Automatic AI code reviews](api-server/docs/CODE_REVIEWS.md)
- [Website development](landing-page/README.md)

## Contributing

Contributions are welcome, including bug reports, design feedback, documentation improvements, and code.

1. Open an issue to describe a bug or discuss a substantial change.
2. Keep changes focused and explain the problem they solve.
3. Follow the conventions of the application you are modifying.
4. Run that application's checks and production build before submitting a pull request.

Keep implemented behavior distinct from design previews and planned features. Never commit credentials, real provider tokens, or private repository content in examples or tests. The journal currently includes sample editorial content based on the design mockups; RSS subscriptions do not use an email delivery service.

## License

OpenReview is licensed under the [MIT License](LICENSE).
