import { createSignal, For, Show } from "solid-js";
import type { AuthUser } from "./lib/auth-client";
import { createDashboardData } from "./lib/dashboard-data";
import {
  ApiNotice,
  ConnectionPanel,
  PullCards,
  PullRequestBrowser,
  RepositoryBrowser,
} from "./components/GitHubDashboard";
import { formatCount, formatTimestamp } from "./lib/format";
import ModelsPage from "./components/ModelsPage";
import SettingsPage from "./components/SettingsPage";
import ReviewRulesPage from "./components/ReviewRulesPage";

type DashboardProps = {
  user: AuthUser;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  onSignOut: () => Promise<void>;
  signingOut: boolean;
  authError: string;
  onReconnect: () => void;
  reconnecting: boolean;
  onSessionRequired: () => void;
};

const navigation = [
  { label: "Overview", icon: "⊞", view: "overview" },
  { label: "Repositories", icon: "▤", view: "repositories" },
  { label: "Pull Requests", icon: "⑂", view: "pull-requests" },
  { label: "Review Rules", icon: "☷", view: "review-rules" },
  { label: "Models & Agents", icon: "⬡", view: "models" },
  { label: "Settings", icon: "⚙", view: "settings" },
] as const;

export default function Dashboard(props: DashboardProps) {
  const [collapsed, setCollapsed] = createSignal(false);
  const model = createDashboardData({
    userId: () => props.user.id,
    signingOut: () => props.signingOut,
    onSessionRequired: props.onSessionRequired,
  });
  const title = () =>
    navigation.find((item) => item.view === model.view())?.label ?? "Overview";
  const isCodeView = () =>
    model.view() !== "models" &&
    model.view() !== "settings" &&
    model.view() !== "review-rules";
  const errorActions = {
    onReconnect: props.onReconnect,
    onConnection: () => void model.refresh(),
    onChooseRepository: () => model.navigate("repositories"),
  };
  const returnedFromInstallation =
    new URLSearchParams(window.location.search).get("github") === "connected";
  let mobileMenu!: HTMLDialogElement;

  const initials = () =>
    props.user.name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "U";

  const ThemeControl = () => (
    <button
      type="button"
      class="dashboard-theme"
      onClick={props.onToggleTheme}
      aria-label={`Switch to ${props.theme === "dark" ? "light" : "dark"} theme`}
    >
      <span aria-hidden="true">◐</span> {props.theme}
    </button>
  );

  const AccountControl = () => (
    <div class="sidebar-account">
      <span class="dashboard-avatar" aria-hidden="true">
        {initials()}
      </span>
      <div class="sidebar-label">
        <strong>{props.user.name}</strong>
        <span title={props.user.email}>{props.user.email}</span>
      </div>
      <button
        type="button"
        class="sidebar-logout"
        aria-label={props.signingOut ? "Signing out…" : "Sign out"}
        title="Sign out"
        disabled={props.signingOut}
        onClick={() => void props.onSignOut()}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M9 4H4v16h5m5-13 5 5-5 5M8 12h11" />
        </svg>
      </button>
    </div>
  );

  const SidebarContent = () => (
    <>
      <a
        href="/dashboard"
        class="dashboard-brand"
        aria-label="OpenReview overview"
      >
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
        <span class="sidebar-label">openreview</span>
      </a>

      <nav class="dashboard-nav" aria-label="Main navigation">
        <For each={navigation}>
          {(item) => (
            <button
              type="button"
              classList={{
                "nav-item": true,
                "is-active": model.view() === item.view,
              }}
              aria-current={model.view() === item.view ? "page" : undefined}
              aria-label={item.label}
              title={item.label}
              onClick={() => {
                model.navigate(item.view);
                mobileMenu.close();
              }}
            >
              <span class="nav-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span class="sidebar-label">{item.label}</span>
            </button>
          )}
        </For>
      </nav>

      <div class="sidebar-bottom">
        <button
          type="button"
          class="sidebar-collapse"
          aria-label={collapsed() ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed()}
          onClick={() => setCollapsed(!collapsed())}
        >
          <span aria-hidden="true">{collapsed() ? "›" : "‹"}</span>
          <span class="sidebar-label">Collapse sidebar</span>
        </button>
        <AccountControl />
      </div>
    </>
  );

  return (
    <div class="dashboard" classList={{ "sidebar-is-collapsed": collapsed() }}>
      <a class="dashboard-skip" href="#dashboard-main">
        Skip to content
      </a>
      <aside class="dashboard-sidebar" aria-label="Workspace sidebar">
        <SidebarContent />
      </aside>

      <dialog
        ref={mobileMenu}
        class="dashboard-mobile-menu"
        aria-label="Workspace navigation"
        onClick={(event) => {
          if (event.target === event.currentTarget) mobileMenu.close();
        }}
      >
        <div class="mobile-menu-content">
          <button
            class="mobile-menu-close"
            type="button"
            aria-label="Close navigation"
            onClick={() => mobileMenu.close()}
          >
            ×
          </button>
          <SidebarContent />
          <ThemeControl />
        </div>
      </dialog>

      <div class="dashboard-workspace">
        <header class="dashboard-topbar">
          <button
            class="mobile-menu-trigger"
            type="button"
            aria-label="Open navigation"
            aria-haspopup="dialog"
            onClick={() => mobileMenu.showModal()}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              aria-hidden="true"
            >
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <p class="dashboard-breadcrumb">OpenReview / {title()}</p>
          <p class="mobile-page-title">{title()}</p>
          <div class="desktop-theme-control">
            <ThemeControl />
          </div>
        </header>

        <main id="dashboard-main" class="dashboard-main" tabIndex={-1}>
          <p class="auth-error" role="alert" hidden={!props.authError}>
            {props.authError}
          </p>
          <section class="dashboard-intro" aria-labelledby="dashboard-heading">
            <p class="dashboard-eyebrow">Your work, in focus</p>
            <div class="dashboard-heading-row">
              <h1 id="dashboard-heading">{title()}</h1>
            </div>
            <p class="dashboard-description">
              {model.view() === "review-rules"
                ? "Your codebase. Your standards. Written in Markdown."
                : model.view() === "models"
                  ? "Give every kind of change the right kind of attention."
                  : model.view() === "settings"
                    ? "Your account, your preferences, your workspace."
                    : "A clear path from open PR to confident merge."}
            </p>
          </section>
          <Show when={model.view() === "review-rules"}>
            <ReviewRulesPage />
          </Show>
          <Show when={model.view() === "models"}>
            <ModelsPage userId={props.user.id} />
          </Show>
          <Show when={model.view() === "settings"}>
            <SettingsPage
              user={props.user}
              theme={props.theme}
              onToggleTheme={props.onToggleTheme}
              onSignOut={props.onSignOut}
              signingOut={props.signingOut}
              model={model}
              onReconnect={props.onReconnect}
              reconnecting={props.reconnecting}
            />
          </Show>
          <Show when={isCodeView()}>
            <Show when={returnedFromInstallation}>
              <p class="section-message" role="status">
                GitHub installation returned successfully. Access is checked
                again below.
              </p>
            </Show>
            <ConnectionPanel
              model={model}
              onReconnect={props.onReconnect}
              reconnecting={props.reconnecting}
            />
            <Show when={model.connected()}>
              <div class="repository-scope">
                <label>
                  Repository scope
                  <select
                    aria-label="Repository scope"
                    value={model.repositoryId()}
                    onChange={(event) =>
                      model.chooseRepository(event.currentTarget.value)
                    }
                  >
                    <option value="">All accessible repositories</option>
                    <Show
                      when={
                        !model.repositories
                          .items()
                          .some((repo) => repo.id === model.repositoryId())
                          ? model.selectedRepository()
                          : undefined
                      }
                    >
                      {(repo) => (
                        <option value={repo().id}>{repo().fullName}</option>
                      )}
                    </Show>
                    <For each={model.repositories.items()}>
                      {(repo) => (
                        <option value={repo.id}>{repo.fullName}</option>
                      )}
                    </For>
                  </select>
                </label>
                <button
                  type="button"
                  class="dashboard-control"
                  onClick={() => model.navigate("repositories")}
                >
                  Browse repositories
                </button>
                <Show when={model.repositories.loading()}>
                  <span class="section-message" role="status">
                    Loading repositories…
                  </span>
                </Show>
              </div>
              <Show
                when={
                  model.view() !== "repositories"
                    ? model.repositories.error()
                    : null
                }
              >
                {(error) => (
                  <ApiNotice
                    error={error()}
                    onRetry={() => void model.repositories.retry()}
                    {...errorActions}
                  />
                )}
              </Show>
              <Show when={model.view() === "overview"}>
                <section
                  class="dashboard-metrics"
                  aria-label="GitHub statistics"
                  aria-busy={model.overview.loading()}
                >
                  <article class="metric-card">
                    <p class="metric-value">
                      {formatCount(model.overview.value()?.repositoryCount)}
                    </p>
                    <h2>Repositories</h2>
                    <p class="metric-context">
                      {model.overview.loading()
                        ? "Loading…"
                        : model.overview.value()?.repositoryCount == null
                          ? "Count unavailable"
                          : "Accessible scope"}
                    </p>
                  </article>
                  <article class="metric-card">
                    <p class="metric-value">
                      {formatCount(
                        model.overview.value()?.openPullRequestCount,
                      )}
                    </p>
                    <h2>Open pull requests</h2>
                    <p class="metric-context">
                      {model.overview.loading()
                        ? "Loading…"
                        : model.overview.value()?.openPullRequestCount == null
                          ? "Count unavailable"
                          : "Across selected scope"}
                    </p>
                  </article>
                  <article class="metric-card">
                    <p class="metric-value" aria-label="Not available">
                      —
                    </p>
                    <h2>AI reviews</h2>
                    <p class="metric-context">Not enabled yet</p>
                  </article>
                </section>
                <Show when={model.overview.error()}>
                  {(error) => (
                    <ApiNotice
                      error={error()}
                      onRetry={() => void model.overview.retry()}
                      {...errorActions}
                    />
                  )}
                </Show>
                <section
                  class="dashboard-recent"
                  id="recent-reviews"
                  aria-labelledby="recent-heading"
                >
                  <div class="recent-heading-row">
                    <h2 id="recent-heading">Recent pull requests</h2>
                    <button
                      type="button"
                      class="dashboard-control"
                      onClick={() => model.navigate("pull-requests")}
                    >
                      View all <span aria-hidden="true">→</span>
                    </button>
                  </div>
                  <Show when={model.overview.loading()}>
                    <p class="section-message" role="status">
                      Loading recent pull requests…
                    </p>
                  </Show>
                  <Show when={model.overview.value()}>
                    {(overview) => (
                      <>
                        <PullCards items={overview().recentPullRequests} />
                        <Show when={overview().recentPullRequests.length === 0}>
                          <div class="dashboard-empty-state">
                            <h3>No recent pull requests</h3>
                            <p>
                              There are no recent pull requests in this
                              accessible scope.
                            </p>
                          </div>
                        </Show>
                        <p class="github-data-note">
                          {overview().lastSyncedAt
                            ? `Last synced ${formatTimestamp(overview().lastSyncedAt)}`
                            : "Fetched live from GitHub"}{" "}
                          · GitHub pull requests are not completed OpenReview AI
                          reviews.
                        </p>
                      </>
                    )}
                  </Show>
                </section>
              </Show>
              <Show when={model.view() === "repositories"}>
                <RepositoryBrowser model={model} {...errorActions} />
              </Show>
              <Show when={model.view() === "pull-requests"}>
                <PullRequestBrowser model={model} {...errorActions} />
              </Show>
            </Show>
          </Show>
        </main>
      </div>
    </div>
  );
}
