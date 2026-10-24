# OpenReview

**Less back-and-forth. More forward.**

OpenReview is an open-source code review platform for developers and teams who want a faster, cleaner way to review code. The goal is simple: readable diffs, useful context, and focused conversations that help teams ship with confidence.

## Project status

OpenReview is live at **[app.openreview.si](https://app.openreview.si/)**. Use the hosted application to get started, or explore the source for self-hosting. The public-facing website includes the landing page, journal, manifesto, and visual identity.

The review workspace shown on the landing page is an illustrative interactive preview. Open the live application to use OpenReview.

## Vision

- **Clarity in every diff.** Make changes and their context easy to understand.
- **Conversations that move.** Keep feedback close to the code and make resolutions clear.
- **Developer-first workflows.** Reduce friction between opening a pull request and shipping it.
- **Open by design.** Build a tool that its community can inspect, influence, and improve.

## Repository structure

```text
openreview/
├── landing-page/     # Astro website, journal, and brand identity
│   ├── public/       # Static assets and downloadable logo
│   ├── src/
│   │   ├── components/
│   │   ├── content/blog/
│   │   ├── layouts/
│   │   ├── pages/
│   │   └── styles/
│   └── README.md     # Website-specific documentation
├── LICENSE
└── README.md
```

Each application or package should keep its own setup and implementation documentation alongside its code. This README covers the overall project; see the [website README](landing-page/README.md) for details about the current implementation.

## Getting started

### Dashboard and API deployments

The dashboard (`frontend/`) and API (`api-server/`) have a shared Cloudflare CI/CD
workflow: `dev` deploys hosted dev and `main` deploys production. Required resource,
secret, and production approval setup is in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
The landing page is not included in that deployment workflow.

### Requirements

- Node.js **22.22.0 or newer**
- npm

### Run the website

From the repository root:

```sh
npm --prefix landing-page install
npm --prefix landing-page run dev -- --background
```

Open **http://localhost:4321**.

Manage the background development server:

```sh
npm --prefix landing-page run astro -- dev status
npm --prefix landing-page run astro -- dev logs
npm --prefix landing-page run astro -- dev stop
```

### Check and build

```sh
npm --prefix landing-page run check
npm --prefix landing-page run build
npm --prefix landing-page run preview
```

The production website is generated in `landing-page/dist/`.

## What is available today

| Area         | Implementation                                                                     |
| ------------ | ---------------------------------------------------------------------------------- |
| Landing page | Responsive product introduction with an example review workspace                   |
| Themes       | Phosphor-green dark mode and cobalt-blue light mode, with a saved theme preference |
| Journal      | Category filtering, Markdown/MDX content, and RSS                                  |
| Articles     | Generated table of contents, reading time, syntax highlighting, and link sharing   |
| Manifesto    | The principles behind OpenReview                                                   |
| Identity     | Custom logo, brand presentation, and downloadable SVG                              |

The website uses **Astro**, **TypeScript**, and **CSS**, with self-hosted Manrope, Newsreader, and IBM Plex Mono fonts. Primary product links open the [live application](https://app.openreview.si/); source and documentation links lead to this repository. Journal subscriptions use RSS; no email subscription service is connected.

## Contributing

Contributions are welcome, including bug reports, design feedback, documentation improvements, and code.

1. Open an issue to describe a bug or discuss a substantial change.
2. Keep changes focused and explain the problem they solve.
3. Follow the conventions of the application you are modifying.
4. Run that application's checks and production build before submitting a pull request.

For website changes, use the commands above and refer to [`landing-page/README.md`](landing-page/README.md). The articles currently included in the journal are sample editorial content based on the design mockups.

## License

OpenReview is licensed under the [MIT License](LICENSE).
