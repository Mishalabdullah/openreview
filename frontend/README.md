## Usage

### Authentication setup

The existing UI uses the Better Auth SolidJS client with cookie-based sessions.

1. Start the API at `http://localhost:1337` after configuring its secrets and
   applying its database migrations (see `../api-server/README.md`).
2. Copy `.env.example` to `.env`, or set `VITE_API_URL=http://localhost:1337`
   in your existing frontend `.env`.
3. Start the frontend at `http://localhost:5173`. Use `localhost` consistently;
   do not mix it with `127.0.0.1` because authentication uses same-site cookies.

GitHub sign-in uses `authClient.signIn.social()` and an absolute frontend
`/dashboard` callback URL. The GitHub OAuth app's authorization callback is
`http://localhost:1337/api/auth/callback/github` (the API, not the frontend).

`/dashboard` and every nested `/dashboard/*` route wait for the session check before
rendering and redirect signed-out users to `/`, with a retry state if verification fails. Signed-in
users on `/` are redirected to `/dashboard`. Sign-out is available in the account
menu and mobile navigation. Backend API authorization remains required; the
frontend guard is not a substitute for server-side access control.

Use `apiFetch()` from `src/lib/api.ts` for application endpoints; it always sets
`credentials: "include"`. The auth client also includes credentials on all calls.
Never put database URLs, OAuth client secrets, or auth secrets in `VITE_*` variables.
The account uses the real session user. GitHub identity and repository access are
separate from OpenReview workspaces; the UI does not invent or automatically create
workspace memberships.

### GitHub dashboard

The API contract is [`../api-server/docs/GITHUB_API.md`](../api-server/docs/GITHUB_API.md).
The frontend integrates:

- `GET /api/v1/github/connection`: identity, connected/disconnected/installation/
  reauthorization states, suspended installations, and installation pagination.
- `GET /api/v1/repositories`: installation, debounced search, and archived filters;
  opaque-cursor pagination and repository selection.
- `GET /api/v1/pull-requests`: combined or repository-specific PR lists, state,
  draft, sort, direction, and pagination.
- `GET /api/v1/dashboard/overview`: authoritative repository/open-PR counts,
  recent PRs, nullable review metrics and sync timestamp.

Overview, Repositories and Pull Requests reuse the existing dashboard shell at
`/dashboard`, `/dashboard/repositories`, and `/dashboard/pull-requests`. Other
navigation items remain explicitly unavailable. PR links open the real GitHub PR;
the optional detail/files endpoints are not used because there is no diff-detail UI.

`null` counts display as unknown (`—`), while zero displays as `0`. GitHub PRs are
not presented as completed AI reviews. No last-sync time is fabricated for live data.
Lists fetch one page at a time, retain filters, deduplicate by string ID, cancel stale
requests, and allow continuation after empty pages. Invalid/expired cursors offer
a restart. Rate-limit responses disable retries until `Retry-After` has elapsed;
no automatic retry loop is used. Data is component-scoped and cleared on sign-out,
session expiry and user changes. GitHub failures do not log out a valid session.

### Manual integration checklist

1. Run the configured backend at `http://localhost:1337` and frontend at
   `http://localhost:5173`. The only public frontend variable is `VITE_API_URL`.
2. Sign in with GitHub. Confirm the session survives refresh and signed-out users
   cannot visit `/dashboard` or nested dashboard routes.
3. If installation is required, choose **Install GitHub App**. The browser navigates
   to the API-provided `installUrl`; it is not fetched by AJAX. The backend must have
   `GITHUB_APP_SLUG` configured, the documented Setup URL, and approved Metadata /
   Pull requests read permissions. These are backend/App setup steps, not Vite secrets.
4. Complete installation and return to `/dashboard?github=connected`. A fresh page
   reloads connection, repository and overview data. Suspended installations are
   marked and cannot be selected as a repository filter.
5. Open **Repositories**. Search, change installation/archive filters, and use
   **Load more repositories**. An empty page may still have a continuation. Choose
   **View pull requests**, or use the shared **Repository scope** selector.
6. Open **Pull Requests**. Test open/closed/merged states, drafts, sort and direction.
   Changing filters restarts pagination. **All accessible repositories** is the
   intersection of user access and app installation access, not all GitHub repos.
7. Sign out through the account menu or mobile drawer. Confirm that private data
   disappears and revisiting a protected route returns to sign-in.

Live GitHub verification requires a real authenticated browser session and an
installed/approved GitHub App. Unit tests and mocked-browser checks do not prove
that the configured app has live repository permissions.

### Checks

```sh
npm run typecheck
npm test
npm run build
npm run format:check
```

Vitest covers credentialed requests, safe errors, connection-state responses,
rate limits, null counts, opaque cursors, deduplication, empty continuation pages,
filter resets, invalid cursors, cancellation and stale response suppression.

```bash
$ npm install # or pnpm install or yarn install
```

### Learn more on the [Solid Website](https://solidjs.com) and come chat with us on our [Discord](https://discord.com/invite/solidjs)

## Available Scripts

In the project directory, you can run:

### `npm run dev`

Runs the app in the development mode.<br>
Open [http://localhost:5173](http://localhost:5173) to view it in the browser.

### `npm run build`

Builds the app for production to the `dist` folder.<br>
It correctly bundles Solid in production mode and optimizes the build for the best performance.

The build is minified and the filenames include the hashes.<br>
Your app is ready to be deployed!

## Deployment

Learn more about deploying your application with the [documentations](https://vite.dev/guide/static-deploy.html)
