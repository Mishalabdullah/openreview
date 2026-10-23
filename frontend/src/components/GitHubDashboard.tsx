import { createSignal, createEffect, For, onCleanup, Show } from "solid-js";
import type { ApiError } from "../lib/api";
import type { DashboardData } from "../lib/dashboard-data";
import type { PullRequest } from "../lib/github-types";
import { formatTimestamp } from "../lib/format";
import { CodeReview, RepositoryReviewSettings } from "./CodeReviews";

type Actions = {
  onReconnect: () => void;
  onConnection: () => void;
  onChooseRepository: () => void;
};

export function ApiNotice(
  props: { error: ApiError; onRetry: () => void } & Actions,
) {
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    const retryAt = props.error.retryAt;
    setNow(Date.now());
    if (retryAt == null || retryAt <= Date.now()) return;
    const interval = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= retryAt) window.clearInterval(interval);
    }, 1000);
    onCleanup(() => window.clearInterval(interval));
  });
  const seconds = () =>
    Math.max(0, Math.ceil(((props.error.retryAt ?? 0) - now()) / 1000));
  const action = () => {
    switch (props.error.code) {
      case "GITHUB_REAUTH_REQUIRED":
        return { label: "Reconnect GitHub", run: props.onReconnect };
      case "GITHUB_INSTALLATION_REQUIRED":
        return { label: "Check connection", run: props.onConnection };
      case "GITHUB_QUERY_TOO_LARGE":
      case "GITHUB_SEARCH_LIMIT":
      case "GITHUB_QUERY_UNSUPPORTED":
        return { label: "Choose a repository", run: props.onChooseRepository };
      case "INVALID_CURSOR":
        return { label: "Start again", run: props.onRetry };
      default:
        return { label: "Try again", run: props.onRetry };
    }
  };
  return (
    <div class="api-notice">
      <p role="alert">{props.error.message}</p>
      <Show when={props.error.requestId}>
        <p class="request-reference">Reference: {props.error.requestId}</p>
      </Show>
      <button
        type="button"
        class="dashboard-control"
        disabled={seconds() > 0}
        onClick={() => action().run()}
      >
        {seconds() > 0 ? `Try again in ${seconds()}s` : action().label}
      </button>
    </div>
  );
}

export function ConnectionPanel(props: {
  model: DashboardData;
  onReconnect: () => void;
  reconnecting: boolean;
}) {
  const model = props.model;
  const actions = {
    onReconnect: props.onReconnect,
    onConnection: () => void model.refresh(),
    onChooseRepository: () => model.navigate("repositories"),
  };
  return (
    <section
      class="github-connection"
      aria-labelledby="github-connection-heading"
      aria-busy={model.connection.loading()}
    >
      <div class="github-connection-heading">
        <div>
          <h2 id="github-connection-heading">GitHub connection</h2>
          <Show when={model.connection.metadata()?.account}>
            {(account) => (
              <p>
                Signed in to GitHub as <strong>{account().login}</strong>
              </p>
            )}
          </Show>
        </div>
        <button
          type="button"
          class="dashboard-control"
          disabled={model.connection.loading()}
          onClick={() => void model.refresh()}
        >
          Refresh connection
        </button>
      </div>
      <Show when={model.connection.loading() && !model.connection.metadata()}>
        <p class="section-message" role="status">
          Checking GitHub access…
        </p>
      </Show>
      <Show when={model.status() === "connected"}>
        <p class="section-message">
          Only repositories accessible to both your account and this GitHub App
          are included.
        </p>
        <ul class="installation-list" aria-label="GitHub App installations">
          <For each={model.connection.items()}>
            {(installation) => (
              <li>
                <span>
                  {installation.accountLogin ?? "Account unavailable"}
                </span>
                <span>
                  {installation.repositorySelection === "all"
                    ? "All repositories"
                    : "Selected repositories"}
                </span>
                <Show when={installation.suspended}>
                  <strong class="status-warning">
                    Suspended — access unavailable
                  </strong>
                </Show>
              </li>
            )}
          </For>
        </ul>
        <Show
          when={
            model.connection.pagination().hasMore && !model.connection.error()
          }
        >
          <button
            type="button"
            class="dashboard-control"
            disabled={model.connection.loading()}
            onClick={() => void model.connection.more()}
          >
            {model.connection.loading()
              ? "Loading…"
              : "Load more installations"}
          </button>
        </Show>
      </Show>
      <Show when={model.status() === "installation_required"}>
        <p class="section-message">
          GitHub login does not grant repository access. Install the OpenReview
          GitHub App and choose the repositories you want to make accessible.
        </p>
        <Show
          when={model.connection.metadata()?.installUrl}
          fallback={
            <p class="section-message">
              An installation URL is not available. Refresh the connection or
              ask an administrator to check the GitHub App configuration.
            </p>
          }
        >
          {(url) => (
            <button
              type="button"
              class="button"
              onClick={() => window.location.assign(url())}
            >
              Install GitHub App
            </button>
          )}
        </Show>
      </Show>
      <Show
        when={
          model.status() === "reauthorization_required" ||
          model.status() === "disconnected"
        }
      >
        <p class="section-message">
          {model.status() === "disconnected"
            ? "Connect your GitHub account to browse accessible repositories and pull requests."
            : "GitHub authorization has expired or was revoked. Your OpenReview session is still active."}
        </p>
        <button
          type="button"
          class="button"
          disabled={props.reconnecting}
          onClick={props.onReconnect}
        >
          {props.reconnecting
            ? "Connecting…"
            : model.status() === "disconnected"
              ? "Connect GitHub"
              : "Reconnect GitHub"}
        </button>
      </Show>
      <Show when={model.connection.error()}>
        {(error) => (
          <ApiNotice
            error={error()}
            onRetry={() => void model.connection.retry()}
            {...actions}
          />
        )}
      </Show>
    </section>
  );
}

export function RepositoryBrowser(props: { model: DashboardData } & Actions) {
  const model = props.model;
  return (
    <section class="dashboard-recent" aria-labelledby="repositories-heading">
      <div class="recent-heading-row">
        <h2 id="repositories-heading">Accessible repositories</h2>
      </div>
      <div class="dashboard-filters">
        <label class="repository-search">
          Search repositories
          <input
            type="search"
            maxLength={100}
            value={model.search()}
            onInput={(event) => model.setSearch(event.currentTarget.value)}
            placeholder="Name or description"
          />
        </label>
        <label>
          Installation
          <select
            value={model.installationId()}
            onChange={(event) =>
              model.setInstallationId(event.currentTarget.value)
            }
          >
            <option value="">All installations</option>
            <For each={model.connection.items()}>
              {(item) => (
                <option value={item.id} disabled={item.suspended}>
                  {item.accountLogin ?? item.id}
                  {item.suspended ? " (suspended)" : ""}
                </option>
              )}
            </For>
          </select>
        </label>
        <label>
          Archived
          <select
            value={model.archived()}
            onChange={(event) =>
              model.setArchived(
                event.currentTarget.value as "" | "true" | "false",
              )
            }
          >
            <option value="">All repositories</option>
            <option value="false">Active only</option>
            <option value="true">Archived only</option>
          </select>
        </label>
      </div>
      <p class="section-message">
        Installation choices come from the connection panel. Load more
        installations there if needed.
      </p>
      <div class="repository-list" aria-busy={model.repositories.loading()}>
        <For each={model.repositories.items()}>
          {(repo) => (
            <article class="repository-card">
              <div class="repository-card-heading">
                <h3>{repo.fullName}</h3>
                <span class="repository-visibility">
                  {repo.visibility}
                  {repo.archived ? " · Archived" : ""}
                </span>
              </div>
              <Show when={repo.description}>
                <p>{repo.description}</p>
              </Show>
              <div class="repository-card-footer">
                <span>
                  {repo.language ?? "Language unavailable"} · Updated{" "}
                  {formatTimestamp(repo.updatedAt)}
                </span>
                <button
                  type="button"
                  class="dashboard-control"
                  onClick={() => {
                    model.openRepositoryPulls(repo.id);
                  }}
                >
                  View pull requests <span aria-hidden="true">→</span>
                </button>
              </div>
            </article>
          )}
        </For>
      </div>
      <Show
        when={
          model.repositories.loading() ||
          model.search().trim() !== model.repositoriesSearch()
        }
      >
        <p class="section-message" role="status">
          Loading repositories…
        </p>
      </Show>
      <Show when={model.repositories.error()}>
        {(error) => (
          <ApiNotice
            error={error()}
            onRetry={() => void model.repositories.retry()}
            {...props}
          />
        )}
      </Show>
      <Show
        when={
          !model.repositories.loading() &&
          !model.repositories.error() &&
          model.search().trim() === model.repositoriesSearch() &&
          model.repositories.items().length === 0
        }
      >
        <div class="dashboard-empty-state">
          <h3>No repositories on this page</h3>
          <p>
            {model.repositories.pagination().hasMore
              ? "More pages may contain matches. Continue loading to search the accessible scope."
              : "No accessible repositories match these filters. Check the GitHub App's repository selection or adjust your filters."}
          </p>
        </div>
      </Show>
      <Show
        when={
          model.repositories.pagination().hasMore && !model.repositories.error()
        }
      >
        <button
          type="button"
          class="dashboard-control load-more"
          disabled={model.repositories.loading()}
          onClick={() => void model.repositories.more()}
        >
          {model.repositories.loading() ? "Loading…" : "Load more repositories"}
        </button>
      </Show>
    </section>
  );
}

export function PullCards(props: { items: PullRequest[] }) {
  return (
    <div class="review-list">
      <For each={props.items}>
        {(pull) => (
          <article class="review-card github-pull-card">
            <div class="review-summary">
              <h3>
                <Show when={pull.htmlUrl} fallback={pull.title}>
                  {(url) => (
                    <a href={url()} target="_blank" rel="noopener noreferrer">
                      {pull.title}{" "}
                      <span class="external-link-icon" aria-hidden="true">
                        ↗
                      </span>
                    </a>
                  )}
                </Show>
              </h3>
              <p>
                #{pull.number} · {pull.repository.fullName} ·{" "}
                {pull.author?.login ?? "User unavailable"}
              </p>
            </div>
            <p
              class={`review-status ${pull.state === "merged" ? "status-success" : pull.state === "closed" ? "status-failed" : "status-running"}`}
            >
              {pull.draft && pull.state === "open"
                ? "Draft"
                : pull.state[0].toUpperCase() + pull.state.slice(1)}
            </p>
            <p class="review-detail">
              <time dateTime={pull.updatedAt ?? undefined}>
                {formatTimestamp(pull.updatedAt)}
              </time>
            </p>
            <Show when={pull.labels.length}>
              <div class="pull-labels">
                <For each={pull.labels}>
                  {(label) => <span>{label.name}</span>}
                </For>
              </div>
            </Show>
            <CodeReview pull={pull} />
          </article>
        )}
      </For>
    </div>
  );
}

export function PullRequestBrowser(props: { model: DashboardData } & Actions) {
  const model = props.model;
  return (
    <section class="dashboard-recent" aria-labelledby="pulls-heading">
      <div class="recent-heading-row">
        <h2 id="pulls-heading">Pull requests</h2>
      </div>
      <Show
        when={model.repositoryId()}
        fallback={
          <p class="section-message">
            Select a repository to manage its automatic reviews.
          </p>
        }
      >
        {(id) => <RepositoryReviewSettings repositoryId={id()} />}
      </Show>
      <div class="dashboard-filters">
        <label>
          State
          <select
            value={model.state()}
            onChange={(event) =>
              model.setState(
                event.currentTarget.value as ReturnType<typeof model.state>,
              )
            }
          >
            <option value="open">Open</option>
            <option value="closed">Closed, not merged</option>
            <option value="merged">Merged</option>
            <option value="all">All states</option>
          </select>
        </label>
        <label>
          Draft
          <select
            value={model.draft()}
            onChange={(event) =>
              model.setDraft(event.currentTarget.value as "" | "true" | "false")
            }
          >
            <option value="">All pull requests</option>
            <option value="true">Drafts only</option>
            <option value="false">Non-drafts only</option>
          </select>
        </label>
        <label>
          Sort by
          <select
            value={model.sort()}
            onChange={(event) =>
              model.setSort(event.currentTarget.value as "created" | "updated")
            }
          >
            <option value="updated">Updated</option>
            <option value="created">Created</option>
          </select>
        </label>
        <label>
          Order
          <select
            value={model.direction()}
            onChange={(event) =>
              model.setDirection(event.currentTarget.value as "asc" | "desc")
            }
          >
            <option value="desc">Newest first</option>
            <option value="asc">Oldest first</option>
          </select>
        </label>
      </div>
      <div aria-busy={model.pulls.loading()}>
        <PullCards items={model.pulls.items()} />
      </div>
      <Show when={model.pulls.loading()}>
        <p class="section-message" role="status">
          Loading pull requests…
        </p>
      </Show>
      <Show when={model.pulls.error()}>
        {(error) => (
          <ApiNotice
            error={error()}
            onRetry={() => void model.pulls.retry()}
            {...props}
          />
        )}
      </Show>
      <Show
        when={
          !model.pulls.loading() &&
          !model.pulls.error() &&
          model.pulls.items().length === 0
        }
      >
        <div class="dashboard-empty-state">
          <h3>No pull requests on this page</h3>
          <p>
            {model.pulls.pagination().hasMore
              ? "More matches may be available. Continue to the next page."
              : "No pull requests match the selected repository and filters."}
          </p>
        </div>
      </Show>
      <Show when={model.pulls.pagination().hasMore && !model.pulls.error()}>
        <button
          type="button"
          class="dashboard-control load-more"
          disabled={model.pulls.loading()}
          onClick={() => void model.pulls.more()}
        >
          {model.pulls.loading() ? "Loading…" : "Load more pull requests"}
        </button>
      </Show>
    </section>
  );
}
