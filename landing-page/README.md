# OpenReview website

The Astro implementation of the OpenReview Penpot designs: phosphor-green dark mode, cobalt-blue light mode, and the custom open-loop “or” identity.

## Development

Requires Node.js 22.22 or newer.

```sh
npm install
npm run dev -- --background
```

The development server is available at `http://localhost:4321`. Manage it with `npm run astro -- dev status`, `npm run astro -- dev logs`, and `npm run astro -- dev stop`.

```sh
npm run build    # Generate the static site in dist/
npm run preview  # Preview the production build
```

## Pages

- `/` — landing page and interactive example review
- `/blog/` — journal with category filters and RSS subscription
- `/blog/[slug]/` — Markdown articles, generated table of contents, reading time, sharing, and related reading
- `/about/` — OpenReview manifesto
- `/brand/` — identity system and downloadable SVG mark
- `/rss.xml` — journal RSS feed

## Content and configuration

Add articles to `src/content/blog/` as Markdown or MDX. The collection schema is in `src/content.config.ts`:

```yaml
title: Your article title
description: A short introduction to the article.
pubDate: 2026-10-18
category: Engineering # Engineering | Code review | Open source | Changelog
cover: refactor # refactor | conversation | source | diff
featured: false
```

`author` and `updatedDate` are optional. Level-two headings automatically populate the article table of contents. The included articles are sample editorial content based on the design mockups.

Product links are centralized in `src/consts.ts`. Primary CTAs open the live application at `https://app.openreview.si/`; GitHub remains the source and self-hosting alternative. The canonical site URL defaults to `https://openreview.si`; set `SITE_URL` when building for another domain. The journal subscription uses RSS; no email subscription service is configured.

Shared colors, spacing, typography, and responsive rules live in `src/styles/global.css`. The theme follows the system preference until a visitor makes a choice, which is then persisted in local storage. Fonts are self-hosted using Fontsource packages; no third-party font requests are needed.
