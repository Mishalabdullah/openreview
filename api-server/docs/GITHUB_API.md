# GitHub dashboard API

Base URL: `http://localhost:1337/api/v1`. All routes below require the existing
Better Auth session cookie. Send `credentials: "include"` from the configured
frontend origin. GitHub access/refresh tokens never leave the backend.

## GitHub App setup

Add the public GitHub App **slug** (not its client ID) to backend configuration:

```dotenv
GITHUB_APP_SLUG=your-github-app-slug
```

Enable these GitHub App permissions and approve changes on existing installations:

- Account → Email addresses: Read-only (login)
- Repository → Metadata: Read-only
- Repository → Pull requests: Read-only (lists, details and files)

GitHub login and installation are separate flows. Keep the OAuth **Callback URL**
at `/api/auth/callback/github`. Configure the app's **Setup URL** separately:

| Environment | Setup URL                                                      |
| ----------- | -------------------------------------------------------------- |
| Local       | `http://localhost:1337/api/v1/github/install/callback`         |
| Development | `https://api.dev.openreview.si/api/v1/github/install/callback` |
| Production  | `https://api.openreview.si/api/v1/github/install/callback`     |

Use the separate, already-authenticated installation flow rather than enabling
“Request user authorization (OAuth) during installation”, which sends the user to
the OAuth callback instead of this setup callback. Start installations using the
returned `installUrl`, not a hand-built GitHub URL. The backend issues encrypted,
15-minute state bound to the signed-in user and an HttpOnly browser nonce cookie.
The callback validates both and checks the returned installation against GitHub's
user-installation API. It does not trust an incoming installation ID or connect
anything to an OpenReview organization implicitly.

No App private key or installation access token is required for these endpoints.
They use **GitHub App user access tokens**, so access is the intersection of user
access and app installation/repository selection. A selected GitHub repository
does not automatically grant OpenReview workspace permissions.

The dashboard includes owned repositories and repositories the signed-in GitHub
account can access as a collaborator or organization member; another owner name
does not imply another user's credentials are being used. All repository reads
still require access through that user's GitHub token and app installation.

Settings also offers **Install in another account or organization** to already
connected users. It uses the same signed installation flow and GitHub's account
chooser; GitHub enforces installation rights and organization approval policies.
No additional OAuth scopes or organization directory are requested. To install
on accounts other than the app owner's, the GitHub App must be public (a
Marketplace listing is not required). A private app is limited to its owning
account. After installation, the callback refreshes dashboard access; an install
request awaiting approval does not grant repository access.

## Endpoints

### `GET /github/connection?limit=30&cursor=...`

Returns `{ data: { status, account, installations, installUrl, lastSyncedAt },
pagination }`. Installation lists are paginated (limit 1–100).

- `connected`: GitHub identity is authorized and at least one installation exists;
  check individual installations' `suspended` flag. `installUrl` is also available
  when `GITHUB_APP_SLUG` is configured, for installation in another account.
- `installation_required`: authorized identity but no installations; navigate the
  browser to `installUrl`. `GITHUB_APP_SLUG` must be configured for this flow.
- `reauthorization_required`: expired, revoked, unrefreshable, or invalid token;
  repeat Better Auth GitHub sign-in.
- `disconnected`: the OpenReview user has no linked GitHub account.

These states return HTTP 200 so the frontend can render a connection prompt.
API/network/rate-limit errors still use non-200 responses. Unavailable identity
fields are null, and no credentials or provider account rows are returned.

### `GET /repositories?limit=30&cursor=...`

Optional filters: `installationId` (string ID), `search` (case-insensitive substring
of full name/description, maximum 100 characters), `archived=true|false`.

Returns `{ data: Repository[], pagination }` using the requested repository fields:
string `id`/`installationId`, owner, description, URL, visibility, default branch,
language, archived flag, timestamp, and read/write/admin permissions. Repositories
are enumerated through `/user/installations/{id}/repositories`; public repository
visibility alone is never taken as evidence of an app installation's access.

### `GET /pull-requests?repositoryId=...&state=open&limit=30&cursor=...`

Omit `repositoryId` for the globally ordered combined list. Filters:

| Parameter   | Values / default                            |
| ----------- | ------------------------------------------- |
| `state`     | `open` (default), `closed`, `merged`, `all` |
| `draft`     | `true`, `false`, or omitted                 |
| `sort`      | `created`, `updated` (default)              |
| `direction` | `asc`, `desc` (default)                     |
| `limit`     | 1–30, default 30                            |

`closed` means closed **without merging**; use `merged` or `all` for merged PRs.
Merged state is derived from `merged_at`, not GitHub's raw `closed` status. Each
PR has string IDs, head/base refs and SHAs, author (null for unavailable users),
labels and nullable ISO timestamps. `appReview` is null until a saved OpenReview
run exists; when review support is enabled it contains the latest matching run,
findings, publication status and a `stale` flag for an older commit. See
[CODE_REVIEWS.md](CODE_REVIEWS.md).

Repository-specific lists use the REST pulls API. Combined lists use disjoint,
access-checked repository scopes in GitHub's PR-only search API, merge those sorted
streams, and hydrate only the requested PRs. A cursor records consumed positions
across the combined stream, not “page one per repository”. No request enumerates
all historical PRs or treats existing GitHub reviews as OpenReview AI reviews.

### `GET /dashboard/overview?repositoryId=...`

Returns `{ data: { repositoryCount, openPullRequestCount, reviewMetrics,
recentPullRequests, lastSyncedAt } }`.

- Repository count covers the complete successfully enumerated accessible scope.
- Open PR count is the sum of PR-only search totals across disjoint scopes, **not**
  page length or `open_issues_count`. GitHub search is eventually consistent.
- Counts are null if GitHub marks count queries incomplete; unavailable counts
  are never fabricated as zero. PR result queries that are incomplete fail explicitly.
- Recent PRs use the same PR structure and are capped at five.
- `reviewMetrics` is null when review credentials are missing, otherwise it contains database
  counts `{ completed, pending, failed }` across the accessible repository scope.
  These count runs; a completed analysis with failed publication can appear in both
  completed and failed counts. Review progress is overlaid **outside** the GitHub
  response cache. `lastSyncedAt` stays null because these APIs fetch
  live data and do not claim a persisted synchronization occurred.

### Detail and files

```text
GET /repositories/:repositoryId/pull-requests/:number
GET /repositories/:repositoryId/pull-requests/:number/files?limit=30&cursor=...
```

Detail extends the PR object with body, additions, deletions, changedFiles and
nullable mergeable. Files contain filename, nullable previousFilename, status,
additions, deletions and nullable patch. GitHub can omit/truncate patches; a
returned patch is never a guarantee of a complete diff. GitHub itself caps the
files endpoint at 3,000 files; do not use it as a complete source for larger PRs.

## Pagination, limits and access changes

Lists return:

```json
{ "pagination": { "nextCursor": null, "hasMore": false } }
```

Pass `nextCursor` unchanged and preserve filters. Cursors are encrypted and
authenticated, user-bound, endpoint-bound, and expire after 15 minutes. Altered,
expired or cross-user cursors return `400 INVALID_CURSOR`. Combined cursors also
bind the current installation/repository scope: restart when access changes.
Each request validates the OpenReview session and linked GitHub account. GitHub
access/data checks may be reused for at most 30 seconds; see the cache policy below.

Filtered repository and repository-specific PR pages may be empty **with
`hasMore: true`** when a bounded scan finds no matching items. Follow the cursor
until `hasMore` is false; do not infer exhaustion from an empty array.

These are GitHub pages with a short cache, not a stable snapshot: PR updates or installation changes
during browsing can change page boundaries. Refresh from the first page to see
the current order.

Work per request is bounded:

- Combined PR/overview inventory: at most 200 repositories and 10 metadata pages.
- GitHub calls: at most 45 per request, each with a 10-second timeout.
- Filtered repository scan: at most six inventory steps per page; PR scan: four.
- GitHub response body: at most 8 MiB; application PR page: at most 30 records.
- GitHub search supports only the first 1,000 results per search scope. Continuing
  beyond that returns `422 GITHUB_SEARCH_LIMIT`; repository-specific REST PR
  browsing is not subject to that search ceiling.

Large inventories return `503 GITHUB_QUERY_TOO_LARGE`, not a truncated “complete”
dataset. The repository browser remains paginated without the 200-repository cap.
Individual repository lookup is still bounded by the metadata-page budget.
Supporting large combined datasets efficiently requires a future incremental
catalog/index and background synchronization, not unbounded Worker fan-out.

## Latency and diagnostics

Cache misses query GitHub over the internet, even when the frontend, backend,
and database run locally. Cold loads do not have a sub-100ms response-time guarantee.
Connection identity/installation queries run concurrently. Overview count and
recent-PR queries also overlap, with PR details fetched in ordered batches of at
most five concurrent calls. Repository inventory still precedes PR queries so
access is checked before fetching repository data.

Authenticated GitHub responses include a `Server-Timing` header: `github_setup`
measures linked-account/token setup, while `github` measures route execution and
describes its upstream request count and cache hits. Session authentication and database cleanup
are outside those durations. Inspect this header in browser DevTools.

### Approved 30-second cache policy

Successful connection/repository/PR-list/overview responses and validated GitHub
GET results use the Workers Cache API. Entries are encrypted, capped at 1 MiB of
plaintext, and isolated by backend origin, user ID, linked account ID, token and
backend secret. Session authentication and linked-account/token checks still run
on **every request**, before cache lookup. Unlinking the account or changing the
token prevents reuse. External browser responses remain `Cache-Control: no-store`.

**GitHub-side data changes and access revocations may take up to 30 seconds to
appear.** Expiry is fixed, not sliding: reading cached metadata cannot extend its
access lifetime in derived responses. Expired entries are never served, including
during GitHub outages. Failures and HTTP-200 reauthorization prompts are not cached.
Installation setup/callbacks always use live checks. Cursor-bearing API responses
are not cached, so cursor validation still runs; upstream GETs can use the cache.

- `X-GitHub-Cache: HIT|MISS|BYPASS` reports primary API response-cache status.
- `X-GitHub-Cache-Age` reports source age in seconds on hits.
- Send `?refresh=true` or `Cache-Control: no-cache` to bypass **both** response and
  upstream caches and replace entries with fresh successful results. The frontend
  Refresh action and return from installation request fresh data for each section.
- No shared database tables, module-level private-data maps or new bindings are
  needed. Entries may be evicted early, are local to a Cloudflare data center,
  and do not provide request collapsing. A miss still waits for GitHub.
- Cache failures fall back to live GitHub; they do not break successful requests.

A persistent local read model plus background synchronization/webhooks is still
needed to avoid cold-load GitHub latency. This short cache is not that read model
and does not promise sub-100ms responses on every request.

## Errors

```json
{
  "error": {
    "code": "GITHUB_REAUTH_REQUIRED",
    "message": "Reconnect GitHub to continue.",
    "requestId": "request-id"
  }
}
```

| HTTP | Code                                                                                   |
| ---- | -------------------------------------------------------------------------------------- |
| 400  | `INVALID_QUERY`, `INVALID_CURSOR`, `INVALID_INSTALLATION_STATE`                        |
| 401  | `SESSION_REQUIRED`                                                                     |
| 403  | `GITHUB_REAUTH_REQUIRED`, `GITHUB_INSTALLATION_REQUIRED`, `GITHUB_PERMISSION_REQUIRED` |
| 404  | `RESOURCE_NOT_FOUND` (also used for inaccessible resources)                            |
| 422  | `GITHUB_SEARCH_LIMIT`                                                                  |
| 429  | `GITHUB_RATE_LIMITED` with `Retry-After`                                               |
| 502  | `GITHUB_UNAVAILABLE`, `GITHUB_INCOMPLETE_RESULTS`                                      |
| 503  | `GITHUB_QUERY_TOO_LARGE`, `GITHUB_QUERY_UNSUPPORTED`, `GITHUB_NOT_CONFIGURED`          |

`X-Request-ID` is included and exposed by credentialed CORS, as is `Retry-After`.
Errors do not expose GitHub responses, provider tokens or database credentials.

## Frontend example

```ts
const api = "http://localhost:1337/api/v1";
const response = await fetch(`${api}/repositories?limit=30`, {
  credentials: "include",
});
const result = await response.json();
if (!response.ok) {
  // Handle result.error.code; respect Retry-After on 429.
  throw new Error(result.error.message);
}
// Render result.data, then request result.pagination.nextCursor when hasMore.
```

For `installation_required`, navigate with
`window.location.assign(connection.data.installUrl)` so the installation state
cookie is established on the API origin before GitHub redirects back.

Tests use disposable PGlite, actual Better Auth sessions/encrypted accounts and
mocked GitHub APIs, including token refresh. They do not prove that your GitHub
App is installed, has approved permissions, or can access your live repositories.
