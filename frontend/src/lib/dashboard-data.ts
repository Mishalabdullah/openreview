import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import { createGitHubApi } from "./github-api";
import { createLatestRequest, createPagedList } from "./requests";
import type {
  Connection,
  Installation,
  PullFilters,
  PullRequest,
  Repository,
  RepositoryFilters,
} from "./github-types";

export type DashboardView =
  | "overview"
  | "repositories"
  | "pull-requests"
  | "review-rules"
  | "models"
  | "settings";

export function dashboardView(pathname: string): DashboardView {
  const view = pathname.split("/")[2];
  return view === "repositories" ||
    view === "pull-requests" ||
    view === "review-rules" ||
    view === "models" ||
    view === "settings"
    ? view
    : "overview";
}

export function createDashboardData(options: {
  userId: () => string;
  signingOut: () => boolean;
  onSessionRequired: () => void;
}) {
  const [view, setView] = createSignal<DashboardView>(
    dashboardView(window.location.pathname),
  );
  const [repositoryId, setRepositoryId] = createSignal("");
  const [search, setSearch] = createSignal("");
  const [debouncedSearch, setDebouncedSearch] = createSignal("", {
    equals: false,
  });
  const [installationId, setInstallationId] = createSignal("");
  const [archived, setArchived] = createSignal<"" | "true" | "false">("");
  const [state, setState] = createSignal<PullFilters["state"]>("open");
  const [draft, setDraft] = createSignal<"" | "true" | "false">("");
  const [sort, setSort] = createSignal<PullFilters["sort"]>("updated");
  const [direction, setDirection] =
    createSignal<PullFilters["direction"]>("desc");
  const [accessIssue, setAccessIssue] = createSignal<
    "installation_required" | "reauthorization_required" | null
  >(null);
  // Selected repositories stay selectable when a different browser filter is applied.
  const [selectedRepository, setSelectedRepository] =
    createSignal<Repository>();
  let installationReloaded = false;

  const api = createGitHubApi((error) => {
    if (error.status === 401) {
      clear();
      options.onSessionRequired();
    } else if (error.code === "GITHUB_REAUTH_REQUIRED") {
      setAccessIssue("reauthorization_required");
    } else if (error.code === "GITHUB_INSTALLATION_REQUIRED") {
      setAccessIssue("installation_required");
      if (!installationReloaded) {
        installationReloaded = true;
        void connection.reset(undefined);
      }
    }
  });
  if (new URLSearchParams(window.location.search).get("github") === "connected")
    api.refresh();

  const connection = createPagedList<Installation, undefined, Connection>(
    async (_, cursor, signal) => {
      const result = await api.connection(cursor, signal);
      return {
        items: result.data.installations,
        pagination: result.pagination,
        metadata: result.data,
      };
    },
  );
  const repositories = createPagedList<Repository, RepositoryFilters>(
    async (query, cursor, signal) => {
      const result = await api.repositories(query, cursor, signal);
      return {
        items: result.data,
        pagination: result.pagination,
        metadata: undefined,
      };
    },
  );
  const pulls = createPagedList<PullRequest, PullFilters>(
    async (query, cursor, signal) => {
      const result = await api.pulls(query, cursor, signal);
      return {
        items: result.data,
        pagination: result.pagination,
        metadata: undefined,
      };
    },
  );
  const overview = createLatestRequest(
    async (id: string | undefined, signal) =>
      (await api.overview(id, signal)).data,
  );
  const status = createMemo(
    () => accessIssue() ?? connection.metadata()?.status,
  );
  const connected = createMemo(
    () => status() === "connected" && !options.signingOut(),
  );

  function clear() {
    batch(() => {
      connection.clear();
      repositories.clear();
      pulls.clear();
      overview.clear();
      setSelectedRepository(undefined);
      setRepositoryId("");
      setSearch("");
      setDebouncedSearch("");
      setInstallationId("");
      setArchived("");
    });
  }

  createEffect(
    on(
      () => [options.userId(), options.signingOut()],
      () => {
        clear();
        if (!options.signingOut()) {
          setAccessIssue(null);
          void connection.reset(undefined);
        }
      },
    ),
  );

  createEffect(
    on(
      search,
      (value) => {
        // Cancel the previous search immediately; only the new request is debounced.
        repositories.clear();
        const timer = window.setTimeout(
          () => setDebouncedSearch(value.trim()),
          300,
        );
        onCleanup(() => window.clearTimeout(timer));
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => [
        connected(),
        debouncedSearch(),
        installationId(),
        archived(),
        view(),
      ],
      () => {
        if (!connected()) return repositories.clear();
        void repositories.sync(
          {
            search: debouncedSearch() || undefined,
            installationId: installationId() || undefined,
            archived: archived() || undefined,
          },
          view() === "overview" ||
            view() === "repositories" ||
            view() === "pull-requests",
        );
      },
    ),
  );

  createEffect(
    on(
      () => [connected(), repositoryId(), view()],
      () => {
        if (!connected()) return overview.clear();
        void overview.sync(repositoryId() || undefined, view() === "overview");
      },
    ),
  );

  createEffect(
    on(
      () => [
        connected(),
        repositoryId(),
        state(),
        draft(),
        sort(),
        direction(),
        view(),
      ],
      () => {
        if (!connected()) return pulls.clear();
        void pulls.sync(
          {
            repositoryId: repositoryId() || undefined,
            state: state(),
            draft: draft() || undefined,
            sort: sort(),
            direction: direction(),
          },
          view() === "pull-requests",
        );
      },
    ),
  );

  function chooseRepository(id: string) {
    setSelectedRepository(repositories.items().find((repo) => repo.id === id));
    setRepositoryId(id);
  }

  function navigate(next: DashboardView) {
    if (next === view()) return;
    setView(next);
    window.history.pushState(
      null,
      "",
      next === "overview" ? "/dashboard" : `/dashboard/${next}`,
    );
  }

  function openRepositoryPulls(id: string) {
    batch(() => {
      chooseRepository(id);
      navigate("pull-requests");
    });
  }
  const handlePopState = () => {
    setView(dashboardView(window.location.pathname));
  };
  window.addEventListener("popstate", handlePopState);
  onCleanup(() => {
    clear();
    window.removeEventListener("popstate", handlePopState);
  });

  function refresh() {
    installationReloaded = false;
    api.refresh();
    return batch(() => {
      setAccessIssue(null);
      return connection.reset(undefined);
    });
  }

  function installApp() {
    const url = connection.metadata()?.installUrl;
    if (url) window.location.assign(url);
  }

  return {
    view,
    navigate,
    connection,
    status,
    connected,
    refresh,
    installApp,
    repositories,
    pulls,
    overview,
    repositoryId,
    chooseRepository,
    openRepositoryPulls,
    selectedRepository,
    search,
    setSearch,
    repositoriesSearch: debouncedSearch,
    installationId,
    setInstallationId,
    archived,
    setArchived,
    state,
    setState,
    draft,
    setDraft,
    sort,
    setSort,
    direction,
    setDirection,
  };
}

export type DashboardData = ReturnType<typeof createDashboardData>;
