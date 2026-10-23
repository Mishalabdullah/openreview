import {
  createEffect,
  createSignal,
  onMount,
  Show,
  lazy,
  Suspense,
  ErrorBoundary,
} from "solid-js";
import { authClient } from "./lib/auth-client";
import { oauthErrorMessage, safeOAuthErrorCode } from "./lib/oauth-errors";

const Dashboard = lazy(() => import("./Dashboard"));

function App() {
  const session = authClient.useSession();
  const pathname = window.location.pathname;
  const isDashboard =
    pathname === "/dashboard" || pathname.startsWith("/dashboard/");
  const [signingIn, setSigningIn] = createSignal(false);
  const [signingOut, setSigningOut] = createSignal(false);
  const [sessionInvalid, setSessionInvalid] = createSignal(false);
  const callbackError = safeOAuthErrorCode(
    new URLSearchParams(window.location.search).get("error"),
  );
  const [authError, setAuthError] = createSignal(
    oauthErrorMessage(callbackError),
  );
  const [theme, setTheme] = createSignal<"dark" | "light">("dark");

  const applyTheme = (value: "dark" | "light") => {
    document.documentElement.dataset.theme = value;
    setTheme(value);
  };

  onMount(() => {
    try {
      const saved = localStorage.getItem("openreview-theme");
      if (saved === "dark" || saved === "light") applyTheme(saved);
    } catch {}
  });

  const toggleTheme = () => {
    const next = theme() === "dark" ? "light" : "dark";
    applyTheme(next);
    try {
      localStorage.setItem("openreview-theme", next);
    } catch {}
  };

  const handleGitHubLogin = async () => {
    if (signingIn()) return;
    setSigningIn(true);
    setAuthError("");
    try {
      const { error } = await authClient.signIn.social({
        provider: "github",
        callbackURL: new URL("/dashboard", window.location.origin).href,
        errorCallbackURL: new URL("/", window.location.origin).href,
      });
      if (error) {
        setAuthError(oauthErrorMessage(error.code ?? "oauth_error"));
        setSigningIn(false);
      }
    } catch {
      setAuthError("Unable to reach the sign-in service. Please try again.");
      setSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    if (signingOut()) return;
    setSigningOut(true);
    setAuthError("");
    try {
      const { error } = await authClient.signOut();
      if (error) {
        setAuthError("Unable to sign out. Please try again.");
      } else {
        window.location.replace("/");
      }
    } catch {
      setAuthError("Unable to reach the sign-in service. Please try again.");
    } finally {
      setSigningOut(false);
    }
  };

  const needsRedirect = () =>
    !session().isPending &&
    !session().error &&
    (isDashboard ? sessionInvalid() || !session().data : !!session().data);

  createEffect(() => {
    if (needsRedirect()) {
      // Preserve safe reconnect errors across the signed-in login-page redirect.
      const destination = callbackError
        ? `/dashboard?error=${callbackError}`
        : "/dashboard";
      window.location.replace(isDashboard ? "/" : destination);
    }
  });

  return (
    <Show
      when={!session().isPending && !needsRedirect()}
      fallback={
        <main class="auth-session-state" role="status">
          Checking your session…
        </main>
      }
    >
      <Show
        when={!isDashboard}
        fallback={
          <Show
            when={!session().error && session().data?.user}
            fallback={
              <main class="auth-session-state">
                <h1>Unable to verify your session</h1>
                <p role="alert">
                  Check that the API is running, then try again.
                </p>
                <button
                  type="button"
                  class="button"
                  onClick={() => void session().refetch()}
                >
                  Try again
                </button>
                <a class="text-link" href="/">
                  Back to sign in
                </a>
              </main>
            }
          >
            {(user) => (
              <ErrorBoundary
                fallback={
                  <main class="auth-session-state">
                    <h1>Unable to load the dashboard</h1>
                    <button
                      type="button"
                      class="button"
                      onClick={() => window.location.reload()}
                    >
                      Reload
                    </button>
                  </main>
                }
              >
                <Suspense
                  fallback={
                    <main class="auth-session-state" role="status">
                      Loading your dashboard…
                    </main>
                  }
                >
                  <Dashboard
                    user={user()}
                    theme={theme()}
                    onToggleTheme={toggleTheme}
                    onSignOut={handleSignOut}
                    signingOut={signingOut()}
                    authError={authError()}
                    onReconnect={() => void handleGitHubLogin()}
                    reconnecting={signingIn()}
                    onSessionRequired={() => {
                      setSessionInvalid(true);
                      window.location.replace("/");
                    }}
                  />
                </Suspense>
              </ErrorBoundary>
            )}
          </Show>
        }
      >
        <div class="sign-in-page">
          <header class="login-header">
            <div class="login-brand" aria-label="OpenReview">
              <svg
                width="24"
                height="24"
                viewBox="0 0 80 80"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M8 29C8 17 17 9 29 9H51V21H29C23 21 20 24 20 30V50C20 56 23 59 29 59H38V31H54C66 31 73 38 73 49V53H61V49C61 45 58 43 54 43H50V71H29C17 71 8 63 8 51Z" />
                <path d="M55 9H73V27H61V21H55ZM57 59H73V71H57Z" />
              </svg>
              <span>openreview</span>
            </div>
            <button
              type="button"
              class="theme-toggle"
              onClick={toggleTheme}
              aria-label={`Switch to ${theme() === "dark" ? "light" : "dark"} theme`}
              title={`Switch to ${theme() === "dark" ? "light" : "dark"} theme`}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                {theme() === "dark" ? (
                  <>
                    <circle cx="12" cy="12" r="4" />
                    <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
                  </>
                ) : (
                  <path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z" />
                )}
              </svg>
              <span>{theme() === "dark" ? "Dark" : "Light"}</span>
            </button>
          </header>

          <main class="login-layout">
            <section
              class="login-editorial"
              aria-labelledby="editorial-heading"
            >
              <p class="login-eyebrow">Open source. Clearer by design.</p>
              <h1 id="editorial-heading">
                Give good code
                <br />a clear path
                <br />
                forward.
              </h1>
              <p class="editorial-description">
                Understand the change. Keep the context.
                <br />
                AI feedback, close to the code.
              </p>
              <p class="editorial-trust">
                Your code. Your rules. Your next merge.
              </p>
            </section>

            <section class="login-auth" aria-labelledby="login-heading">
              <div class="login-auth-content">
                <p class="login-eyebrow">Welcome to OpenReview</p>
                <h2 id="login-heading">A better review starts here.</h2>
                <p class="login-description">
                  Sign in to review pull requests with your team.
                </p>
                <button
                  type="button"
                  class="button github-login"
                  onClick={handleGitHubLogin}
                  disabled={signingIn()}
                  aria-busy={signingIn()}
                >
                  <svg
                    width="22"
                    height="22"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path d="M12 .75a11.25 11.25 0 0 0-3.558 21.923c.563.104.768-.244.768-.542 0-.267-.01-.975-.015-1.914-3.13.68-3.79-1.508-3.79-1.508-.512-1.3-1.25-1.646-1.25-1.646-1.022-.699.077-.685.077-.685 1.13.08 1.725 1.16 1.725 1.16 1.005 1.724 2.637 1.226 3.28.938.102-.728.393-1.226.715-1.508-2.498-.284-5.124-1.249-5.124-5.562 0-1.229.44-2.233 1.16-3.02-.117-.285-.503-1.428.11-2.977 0 0 .945-.302 3.094 1.153A10.79 10.79 0 0 1 12 6.184c.956.005 1.918.13 2.818.379 2.148-1.455 3.091-1.153 3.091-1.153.615 1.549.229 2.692.113 2.976.722.788 1.158 1.792 1.158 3.021 0 4.324-2.63 5.275-5.136 5.553.404.349.764 1.034.764 2.084 0 1.504-.014 2.718-.014 3.087 0 .3.203.652.774.541A11.252 11.252 0 0 0 12 .75Z" />
                  </svg>
                  {signingIn()
                    ? "Connecting to GitHub…"
                    : "Continue with GitHub"}
                </button>
                <Show when={authError()}>
                  <p class="auth-error" role="alert">
                    {authError()}
                  </p>
                </Show>
                <p class="login-permissions">
                  Signing in does not grant repository access.
                  <br />
                  You choose which repositories to connect next.
                </p>
              </div>
              <footer class="login-footer">
                <p class="login-terms">
                  By continuing, you agree to the Terms and Privacy Policy.
                </p>
                <p class="login-source">
                  Built in the open.{" "}
                  <a
                    href="https://github.com/Mishalabdullah/openreview"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View source on GitHub <span aria-hidden="true">↗</span>
                  </a>
                </p>
              </footer>
            </section>
          </main>
        </div>
      </Show>
    </Show>
  );
}

export default App;
