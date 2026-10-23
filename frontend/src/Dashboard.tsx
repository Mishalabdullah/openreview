import { createSignal, For } from "solid-js";

type DashboardProps = {
  theme: "dark" | "light";
  onToggleTheme: () => void;
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

// Design fixtures only. Replace these with authenticated dashboard API data.
const reviews = [
  { id: 128, title: "Simplify auth flow", repo: "platform", author: "Jamie Lee", status: "Needs attention", tone: "warning", detail: "2 issues" },
  { id: 127, title: "Add retry backoff", repo: "platform", author: "Alex Chen", status: "Reviewing…", tone: "running", detail: "4 / 6 files" },
  { id: 126, title: "Improve error messages", repo: "docs", author: "Sam Rivera", status: "Completed", tone: "success", detail: "No issues" },
  { id: 125, title: "Guard webhook signature", repo: "platform", author: "Jamie Lee", status: "Failed", tone: "failed", detail: "Retry review" },
];

export default function Dashboard(props: DashboardProps) {
  const [collapsed, setCollapsed] = createSignal(false);
  const [repository, setRepository] = createSignal("all");
  let mobileMenu!: HTMLDialogElement;

  const filteredReviews = () => reviews.filter(
    (review) => repository() === "all" || review.repo === repository(),
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
      <a href="/dashboard" class="dashboard-brand" aria-label="OpenReview overview">
        <svg width="24" height="24" viewBox="0 0 80 80" fill="currentColor" aria-hidden="true">
          <path d="M8 29C8 17 17 9 29 9H51V21H29C23 21 20 24 20 30V50C20 56 23 59 29 59H38V31H54C66 31 73 38 73 49V53H61V49C61 45 58 43 54 43H50V71H29C17 71 8 63 8 51Z" />
          <path d="M55 9H73V27H61V21H55ZM57 59H73V71H57Z" />
        </svg>
        <span class="sidebar-label">openreview</span>
      </a>

      <div class="workspace-switcher">
        <strong class="sidebar-label">OpenReview <span aria-hidden="true">⌄</span></strong>
        <label class="sidebar-label">
          <span class="sr-only">Filter by repository</span>
          <select value={repository()} onChange={(event) => setRepository(event.currentTarget.value)}>
            <option value="all">platform / All repos</option>
            <option value="platform">platform</option>
            <option value="docs">docs</option>
          </select>
        </label>
        <span class="workspace-initial" aria-hidden="true">O</span>
      </div>

      <nav class="dashboard-nav" aria-label="Main navigation">
        <For each={navigation}>{(item, index) => (
          <button
            type="button"
            classList={{ "nav-item": true, "is-active": index() === 0 }}
            aria-current={index() === 0 ? "page" : undefined}
            aria-label={item.label}
            disabled={index() !== 0}
            title={index() === 0 ? "Overview" : `${item.label} — coming soon`}
            onClick={() => mobileMenu.close()}
          >
            <span class="nav-icon" aria-hidden="true">{item.icon}</span>
            <span class="sidebar-label">{item.label}</span>
          </button>
        )}</For>
      </nav>
      <p class="integration-providers sidebar-label">GitHub · MCP</p>

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
        <div class="sidebar-account">
          <span class="dashboard-avatar" aria-hidden="true">JL</span>
          <div class="sidebar-label">
            <strong>Jamie Lee</strong>
            <span>Personal workspace</span>
          </div>
          <span class="sample-account-label sr-only">Sample account for the dashboard preview</span>
        </div>
      </div>
    </>
  );

  return (
    <div class="dashboard" classList={{ "sidebar-is-collapsed": collapsed() }}>
      <a class="dashboard-skip" href="#dashboard-main">Skip to content</a>
      <aside class="dashboard-sidebar" aria-label="Workspace sidebar">
        <SidebarContent />
      </aside>

      <dialog ref={mobileMenu} class="dashboard-mobile-menu" aria-label="Workspace navigation" onClick={(event) => {
        if (event.target === event.currentTarget) mobileMenu.close();
      }}>
        <div class="mobile-menu-content">
          <button class="mobile-menu-close" type="button" aria-label="Close navigation" onClick={() => mobileMenu.close()}>×</button>
          <SidebarContent />
          <ThemeControl />
        </div>
      </dialog>

      <div class="dashboard-workspace">
        <header class="dashboard-topbar">
          <button class="mobile-menu-trigger" type="button" aria-label="Open navigation" aria-haspopup="dialog" onClick={() => mobileMenu.showModal()}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          <p class="dashboard-breadcrumb">OpenReview / platform</p>
          <p class="mobile-page-title">Overview</p>
          <div class="desktop-theme-control"><ThemeControl /></div>
          <button class="mobile-account-trigger" type="button" popovertarget="dashboard-account" aria-label="Open account and appearance options">JL</button>
          <div id="dashboard-account" popover="auto" class="dashboard-account-popover">
            <strong>Jamie Lee</strong>
            <p>Sample account · UI preview</p>
            <ThemeControl />
          </div>
        </header>

        <main id="dashboard-main" class="dashboard-main" tabIndex={-1}>
          <section class="dashboard-intro" aria-labelledby="dashboard-heading">
            <p class="dashboard-eyebrow">Your work, in focus</p>
            <div class="dashboard-heading-row">
              <h1 id="dashboard-heading">Overview</h1>
              <a class="button dashboard-pr-link" href="#recent-reviews">View pull requests <span aria-hidden="true">→</span></a>
            </div>
            <p class="dashboard-description">A clear path from open PR to confident merge.</p>
          </section>

          <section class="dashboard-metrics" aria-label="Review statistics — sample data">
            <article class="metric-card">
              <p class="metric-value">24</p>
              <h2>PRs reviewed</h2>
              <p class="metric-context">This week</p>
            </article>
            <article class="metric-card">
              <p class="metric-value">3</p>
              <h2>Reviews running</h2>
              <p class="metric-context">2 queued</p>
            </article>
            <article class="metric-card">
              <p class="metric-value status-warning">12</p>
              <h2>Issues found</h2>
              <p class="metric-context">4 need attention</p>
            </article>
          </section>

          <section class="dashboard-recent" id="recent-reviews" aria-labelledby="recent-heading">
            <div class="recent-heading-row">
              <h2 id="recent-heading">Recent PR reviews</h2>
              <span class="review-period">Last 7 days</span>
            </div>
            <div class="review-list">
              <For each={filteredReviews()}>{(review) => (
                <article class="review-card">
                  <div class="review-summary">
                    <h3>{review.title}</h3>
                    <p>#{review.id} · {review.repo} · {review.author}</p>
                  </div>
                  <p class={`review-status status-${review.tone}`}>{review.status}</p>
                  <p class="review-detail">{review.detail}</p>
                </article>
              )}</For>
            </div>
          </section>
          <p class="dashboard-sync">Preview data · Reviews use your repository rules.</p>
        </main>
      </div>
    </div>
  );
}
