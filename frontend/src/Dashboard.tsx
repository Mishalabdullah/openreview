import { createSignal, For } from "solid-js";
import type { AuthUser } from "./lib/auth-client";

type DashboardProps = {
  user: AuthUser;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  onSignOut: () => Promise<void>;
  signingOut: boolean;
  authError: string;
};

const navigation = [
  { label: "Overview", icon: "⊞" },
  { label: "Repositories", icon: "▤" },
  { label: "Pull Requests", icon: "⑂" },
  { label: "Reviews", icon: "▣" },
  { label: "Review Rules", icon: "☷" },
  { label: "Models & Agents", icon: "⬡" },
  { label: "Integrations", icon: "⌁" },
  { label: "Settings", icon: "⚙" },
];

export default function Dashboard(props: DashboardProps) {
  const [collapsed, setCollapsed] = createSignal(false);
  let mobileMenu!: HTMLDialogElement;

  const initials = () =>
    props.user.name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "U";

  const SignOutButton = () => (
    <>
      <button
        type="button"
        class="dashboard-sign-out"
        onClick={() => void props.onSignOut()}
        disabled={props.signingOut}
      >
        {props.signingOut ? "Signing out…" : "Sign out"}
      </button>
      <p class="auth-error" role="alert" hidden={!props.authError}>
        {props.authError}
      </p>
    </>
  );

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

      <div class="workspace-switcher">
        <strong class="sidebar-label">No workspace selected</strong>
        <p class="workspace-description sidebar-label">Workspace setup is not available yet.</p>
        <span class="workspace-initial" aria-hidden="true">
          O
        </span>
      </div>

      <nav class="dashboard-nav" aria-label="Main navigation">
        <For each={navigation}>
          {(item, index) => (
            <button
              type="button"
              classList={{ "nav-item": true, "is-active": index() === 0 }}
              aria-current={index() === 0 ? "page" : undefined}
              aria-label={item.label}
              disabled={index() !== 0}
              title={index() === 0 ? "Overview" : `${item.label} — coming soon`}
              onClick={() => mobileMenu.close()}
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
        <button
          type="button"
          class="sidebar-account"
          popovertarget="dashboard-account"
          aria-label="Open account and appearance options"
          title={props.user.name}
        >
          <span class="dashboard-avatar" aria-hidden="true">
            {initials()}
          </span>
          <div class="sidebar-label">
            <strong>{props.user.name}</strong>
            <span>{props.user.email}</span>
          </div>
        </button>
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
          <SignOutButton />
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
          <p class="dashboard-breadcrumb">OpenReview / Overview</p>
          <p class="mobile-page-title">Overview</p>
          <div class="desktop-theme-control">
            <ThemeControl />
          </div>
          <button
            class="mobile-account-trigger"
            type="button"
            popovertarget="dashboard-account"
            aria-label="Open account and appearance options"
          >
            {initials()}
          </button>
          <div
            id="dashboard-account"
            popover="auto"
            class="dashboard-account-popover"
          >
            <strong>{props.user.name}</strong>
            <p>{props.user.email}</p>
            <ThemeControl />
            <SignOutButton />
          </div>
        </header>

        <main id="dashboard-main" class="dashboard-main" tabIndex={-1}>
          <p class="auth-error" role="alert" hidden={!props.authError}>
            {props.authError}
          </p>
          <section class="dashboard-intro" aria-labelledby="dashboard-heading">
            <p class="dashboard-eyebrow">Your work, in focus</p>
            <div class="dashboard-heading-row">
              <h1 id="dashboard-heading">Overview</h1>
            </div>
            <p class="dashboard-description">
              A clear path from open PR to confident merge.
            </p>
          </section>

          <section
            class="dashboard-metrics"
            aria-label="Review statistics — not available yet"
          >
            <article class="metric-card">
              <p class="metric-value" aria-label="Not available">—</p>
              <h2>PRs reviewed</h2>
              <p class="metric-context">Not available yet</p>
            </article>
            <article class="metric-card">
              <p class="metric-value" aria-label="Not available">—</p>
              <h2>Reviews running</h2>
              <p class="metric-context">Not available yet</p>
            </article>
            <article class="metric-card">
              <p class="metric-value" aria-label="Not available">—</p>
              <h2>Issues found</h2>
              <p class="metric-context">Not available yet</p>
            </article>
          </section>

          <section
            class="dashboard-recent"
            id="recent-reviews"
            aria-labelledby="recent-heading"
          >
            <div class="recent-heading-row">
              <h2 id="recent-heading">Recent PR reviews</h2>
            </div>
            <div class="dashboard-empty-state">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M8 4H5a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1h-3" />
                <rect x="8" y="2" width="8" height="4" rx="1" />
                <path d="M8 11h8M8 15h5" />
              </svg>
              <h3>Review activity is not available yet</h3>
              <p>Your pull request reviews will appear here once repository connections and reviews are enabled.</p>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
