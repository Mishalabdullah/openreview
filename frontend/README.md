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

`/dashboard` and every nested `/dashboard/*` route wait for the session check before rendering and redirect signed-out
users to `/`, and shows a retry state if session verification fails. Signed-in
users on `/` are redirected to `/dashboard`. Sign-out is available in the account
menu and mobile navigation. Backend API authorization remains required; the
frontend guard is not a substitute for server-side access control.

Use `apiFetch()` from `src/lib/api.ts` for application endpoints; it always sets
`credentials: "include"`. The auth client also includes credentials on all calls.
Never put database URLs, OAuth client secrets, or auth secrets in `VITE_*` variables.
The dashboard shows unavailable/empty states until review APIs are implemented;
it does not display fabricated metrics, reviews, repositories, or workspaces.
The account uses the real session user.

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
