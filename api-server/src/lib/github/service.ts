import { z } from "zod";
import { ApiError, notFound } from "../api-error";
import { GitHubClient } from "./client";
import {
  OpaqueTokens,
  fingerprint,
  type PullQuery,
  type RepositoryQuery,
} from "./pagination";
import {
  githubUser,
  installationsResponse,
  repositoriesResponse,
  pullRequest,
  searchResponse,
  mapRepository,
  mapPullRequest,
  type Installation,
  type Repository,
} from "./schemas";

const repositoryCursor = z.object({
  filter: z.string(),
  installationPage: z.number().int().min(1).max(1000),
  installationIndex: z.number().int().min(0).max(99),
  repositoryPage: z.number().int().min(1).max(100_000),
  repositoryOffset: z.number().int().min(0).max(99),
});
const pullCursor = z.object({
  filter: z.string(),
  scope: z.string(),
  offsets: z.array(z.number().int().min(0).max(1000)).max(200),
});
const singlePullCursor = z.object({
  filter: z.string(),
  page: z.number().int().min(1).max(100_000),
  offset: z.number().int().min(0).max(99),
});

// Full inventories are used only to scope combined PR search, never to fetch all PRs.
// Larger installations require an incremental catalog/index, not an unbounded Worker request.
const MAX_INVENTORY_REPOSITORIES = 200;
const MAX_INVENTORY_PAGES = 10;

export class GitHubService {
  readonly client: GitHubClient;
  readonly tokens: OpaqueTokens;
  private installationPages = new Map<
    number,
    { data: z.infer<typeof installationsResponse>; hasNext: boolean }
  >();
  private repositoryPages = new Map<
    string,
    { data: z.infer<typeof repositoriesResponse>; hasNext: boolean }
  >();

  constructor(
    token: string,
    secret: string,
    userId: string,
    fetcher?: typeof fetch,
  ) {
    this.client = new GitHubClient(token, fetcher);
    this.tokens = new OpaqueTokens(secret, userId);
  }

  async installationPage(page: number) {
    const existing = this.installationPages.get(page);
    if (existing) return existing;
    const response = await this.client.get(
      "/user/installations",
      installationsResponse,
      { per_page: 100, page },
    );
    this.installationPages.set(page, response);
    return response;
  }

  async repositoryPage(installationId: string, page: number) {
    const key = `${installationId}:${page}`;
    const existing = this.repositoryPages.get(key);
    if (existing) return existing;
    const response = await this.client.get(
      `/user/installations/${installationId}/repositories`,
      repositoriesResponse,
      { per_page: 100, page },
    );
    this.repositoryPages.set(key, response);
    return response;
  }

  async connection(limit: number, cursor?: string) {
    const state = cursor
      ? await this.tokens.open(
          "connection",
          cursor,
          z.object({ offset: z.number().int().min(0).max(100_000) }),
        )
      : { offset: 0 };
    const user = (await this.client.get("/user", githubUser)).data;
    const page = Math.floor(state.offset / 100) + 1;
    const offset = state.offset % 100;
    const response = await this.installationPage(page);
    const items = response.data.installations.slice(offset, offset + limit);
    const next = state.offset + items.length;
    return {
      data: {
        status: response.data.total_count
          ? ("connected" as const)
          : ("installation_required" as const),
        account: {
          id: user.id,
          login: user.login,
          avatarUrl: user.avatar_url,
          htmlUrl: user.html_url,
        },
        installations: items.map((item) => ({
          id: item.id,
          accountLogin: item.account?.login ?? null,
          accountType: item.account?.type ?? null,
          repositorySelection: item.repository_selection,
          suspended: item.suspended_at !== null,
        })),
        installUrl: null as string | null,
        lastSyncedAt: null,
      },
      pagination: {
        nextCursor:
          next < response.data.total_count
            ? await this.tokens.seal("connection", { offset: next })
            : null,
        hasMore: next < response.data.total_count,
      },
    };
  }

  async repositories(query: RepositoryQuery) {
    const filter = await fingerprint({
      installationId: query.installationId,
      search: query.search,
      archived: query.archived,
    });
    let state = query.cursor
      ? await this.tokens.open("repositories", query.cursor, repositoryCursor)
      : {
          filter,
          installationPage: 1,
          installationIndex: 0,
          repositoryPage: 1,
          repositoryOffset: 0,
        };
    if (state.filter !== filter)
      throw new ApiError(
        400,
        "INVALID_CURSOR",
        "Cursor filters have changed. Start again.",
      );
    const data: ReturnType<typeof mapRepository>[] = [];
    let done = false;
    let matchedInstallation = false;
    // Filtering may return an empty page with a continuation; clients must follow hasMore.
    for (let scanned = 0; scanned < 6 && data.length < query.limit; scanned++) {
      const installations = await this.installationPage(state.installationPage);
      if (installations.data.total_count === 0)
        throw new ApiError(
          403,
          "GITHUB_INSTALLATION_REQUIRED",
          "Install the GitHub App to access repositories.",
        );
      const item = installations.data.installations[state.installationIndex];
      if (!item) {
        if (!installations.hasNext) {
          done = true;
          break;
        }
        state = {
          ...state,
          installationPage: state.installationPage + 1,
          installationIndex: 0,
        };
        continue;
      }
      if (query.installationId === item.id) matchedInstallation = true;
      if (
        item.suspended_at ||
        (query.installationId && item.id !== query.installationId)
      ) {
        state = {
          ...state,
          installationIndex: state.installationIndex + 1,
          repositoryPage: 1,
          repositoryOffset: 0,
        };
        if (state.installationIndex === 100) {
          state.installationPage++;
          state.installationIndex = 0;
        }
        continue;
      }
      const response = await this.repositoryPage(item.id, state.repositoryPage);
      const repos = response.data.repositories;
      while (
        state.repositoryOffset < repos.length &&
        data.length < query.limit
      ) {
        const repo = repos[state.repositoryOffset++];
        if (repo.permissions?.pull === false) continue;
        if (query.archived !== undefined && repo.archived !== query.archived)
          continue;
        if (
          query.search &&
          !`${repo.full_name} ${repo.description ?? ""}`
            .toLowerCase()
            .includes(query.search.toLowerCase())
        )
          continue;
        data.push(mapRepository({ ...repo, installationId: item.id }));
      }
      if (state.repositoryOffset >= repos.length) {
        state.repositoryOffset = 0;
        if (response.hasNext) state.repositoryPage++;
        else {
          state.repositoryPage = 1;
          state.installationIndex++;
          if (query.installationId) {
            done = true;
            break;
          }
          if (
            state.installationIndex >=
              installations.data.installations.length &&
            !installations.hasNext
          ) {
            done = true;
            break;
          }
          if (state.installationIndex === 100) {
            state.installationPage++;
            state.installationIndex = 0;
          }
        }
      }
    }
    if (done && query.installationId && !matchedInstallation) throw notFound();
    return {
      data,
      pagination: {
        nextCursor: done ? null : await this.tokens.seal("repositories", state),
        hasMore: !done,
      },
    };
  }

  async inventory(repositoryId?: string): Promise<Repository[]> {
    const repositories: Repository[] = [];
    let pages = 0;
    for (let installationPage = 1; ; installationPage++) {
      if (++pages > MAX_INVENTORY_PAGES) break;
      const response = await this.installationPage(installationPage);
      if (response.data.total_count === 0)
        throw new ApiError(
          403,
          "GITHUB_INSTALLATION_REQUIRED",
          "Install the GitHub App to access repositories.",
        );
      for (const installation of response.data.installations) {
        if (installation.suspended_at) continue;
        for (let page = 1; ; page++) {
          if (++pages > MAX_INVENTORY_PAGES) throw this.inventoryTooLarge();
          const result = await this.repositoryPage(installation.id, page);
          for (const repo of result.data.repositories) {
            if (repo.permissions?.pull === false) continue;
            const value = { ...repo, installationId: installation.id };
            if (repositoryId && repo.id === repositoryId) return [value];
            if (!repositoryId) repositories.push(value);
          }
          if (repositories.length > MAX_INVENTORY_REPOSITORIES)
            throw this.inventoryTooLarge();
          if (!result.hasNext) break;
        }
      }
      if (!response.hasNext) {
        if (repositoryId) throw notFound();
        return repositories.sort((a, b) => a.id.localeCompare(b.id));
      }
    }
    throw this.inventoryTooLarge();
  }

  private inventoryTooLarge() {
    return new ApiError(
      503,
      "GITHUB_QUERY_TOO_LARGE",
      "The live repository inventory is too large. Select a repository or use paginated repository browsing.",
    );
  }

  private repoPath(repo: Repository) {
    return `/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}`;
  }

  async pull(repo: Repository, number: number) {
    return (
      await this.client.get(
        `${this.repoPath(repo)}/pulls/${number}`,
        pullRequest,
      )
    ).data;
  }

  async repositoryPulls(repo: Repository, query: PullQuery) {
    const filter = await fingerprint({
      repositoryId: repo.id,
      state: query.state,
      draft: query.draft,
      sort: query.sort,
      direction: query.direction,
    });
    const state = query.cursor
      ? await this.tokens.open(
          "repository-pulls",
          query.cursor,
          singlePullCursor,
        )
      : { filter, page: 1, offset: 0 };
    if (state.filter !== filter)
      throw new ApiError(
        400,
        "INVALID_CURSOR",
        "Cursor filters have changed. Start again.",
      );
    const data: ReturnType<typeof mapPullRequest>[] = [];
    let done = false;
    for (let scanned = 0; scanned < 4 && data.length < query.limit; scanned++) {
      const response = await this.client.get(
        `${this.repoPath(repo)}/pulls`,
        z.array(pullRequest),
        {
          state: query.state === "merged" ? "closed" : query.state,
          sort: query.sort,
          direction: query.direction,
          per_page: 100,
          page: state.page,
        },
      );
      while (state.offset < response.data.length && data.length < query.limit) {
        const pr = response.data[state.offset++];
        if (query.state === "merged" && !pr.merged_at) continue;
        if (query.state === "closed" && pr.merged_at) continue;
        if (query.draft !== undefined && (pr.draft ?? false) !== query.draft)
          continue;
        data.push(mapPullRequest(pr, repo));
      }
      if (state.offset >= response.data.length) {
        if (!response.hasNext) {
          done = true;
          break;
        }
        state.page++;
        state.offset = 0;
      }
    }
    return {
      data,
      pagination: {
        nextCursor: done
          ? null
          : await this.tokens.seal("repository-pulls", state),
        hasMore: !done,
      },
    };
  }

  private searchQueries(
    repos: Repository[],
    query: Pick<PullQuery, "state" | "draft">,
  ) {
    const qualifiers = ["is:pull-request"];
    if (query.state === "open") qualifiers.push("is:open");
    if (query.state === "closed") qualifiers.push("is:closed", "is:unmerged");
    if (query.state === "merged") qualifiers.push("is:merged");
    if (query.draft !== undefined) qualifiers.push(`draft:${query.draft}`);
    const chunks: string[] = [];
    let names: string[] = [];
    for (const repo of repos) {
      // GitHub repository names are constrained; never interpolate arbitrary search input.
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.full_name))
        throw this.inventoryTooLarge();
      const name = `repo:${repo.full_name}`;
      if (
        names.length === 20 ||
        [...qualifiers, ...names, name].join(" ").length > 800
      ) {
        chunks.push([...qualifiers, ...names].join(" "));
        names = [];
      }
      names.push(name);
    }
    if (names.length) chunks.push([...qualifiers, ...names].join(" "));
    return chunks;
  }

  async combinedPulls(repos: Repository[], query: PullQuery) {
    const queries = this.searchQueries(repos, query);
    const filter = await fingerprint({
      state: query.state,
      draft: query.draft,
      sort: query.sort,
      direction: query.direction,
    });
    const scope = await fingerprint(
      repos.map((repo) => [repo.id, repo.full_name, repo.installationId]),
    );
    const state = query.cursor
      ? await this.tokens.open("combined-pulls", query.cursor, pullCursor)
      : {
          filter,
          scope,
          offsets: queries.map(() => 0),
        };
    if (
      state.filter !== filter ||
      state.scope !== scope ||
      state.offsets.length !== queries.length
    ) {
      throw new ApiError(
        400,
        "INVALID_CURSOR",
        "Repository access or cursor filters changed. Start again.",
      );
    }
    const data: ReturnType<typeof mapPullRequest>[] = [];
    const pages = new Map<string, z.infer<typeof searchResponse>>();
    const head = async (index: number) => {
      const offset = state.offsets[index];
      const page = Math.floor(offset / 100) + 1;
      const key = `${index}:${page}`;
      if (!pages.has(key)) {
        const response = await this.client.get(
          "/search/issues",
          searchResponse,
          {
            q: queries[index],
            sort: query.sort,
            order: query.direction,
            per_page: 100,
            page: Math.min(page, 10),
          },
        );
        if (response.data.incomplete_results)
          throw new ApiError(
            502,
            "GITHUB_INCOMPLETE_RESULTS",
            "GitHub returned incomplete search results. Retry or select a repository.",
          );
        if (offset >= 1000 && response.data.total_count > 1000) {
          throw new ApiError(
            422,
            "GITHUB_SEARCH_LIMIT",
            "GitHub search limits each query to 1,000 PRs. Select a repository to continue browsing.",
          );
        }
        pages.set(key, response.data);
      }
      const result = pages.get(key)!;
      if (offset >= result.total_count) return null;
      const item = result.items[offset % 100];
      if (!item)
        throw new ApiError(
          502,
          "GITHUB_INCOMPLETE_RESULTS",
          "GitHub search results changed. Start again.",
        );
      return item;
    };
    const heads = await Promise.all(queries.map((_, index) => head(index)));
    const byName = new Map(
      repos.map((repo) => [repo.full_name.toLowerCase(), repo]),
    );
    for (
      let scanned = 0;
      scanned < query.limit + 10 && data.length < query.limit;
      scanned++
    ) {
      const candidates = heads.flatMap((item, index) =>
        item ? [{ item, index }] : [],
      );
      if (!candidates.length) break;
      candidates.sort((a, b) => {
        const field = query.sort === "created" ? "created_at" : "updated_at";
        const comparison =
          a.item[field].localeCompare(b.item[field]) ||
          a.item.id.localeCompare(b.item.id);
        return query.direction === "asc" ? comparison : -comparison;
      });
      const selected = candidates[0];
      const repositoryURL = new URL(selected.item.repository_url);
      const name = repositoryURL.pathname
        .replace(/^\/repos\//, "")
        .toLowerCase();
      const repo = byName.get(name);
      if (!repo || repositoryURL.origin !== "https://api.github.com")
        throw notFound();
      const pr = await this.pull(repo, selected.item.number);
      const normalized = mapPullRequest(pr, repo);
      if (
        (query.state === "all" || normalized.state === query.state) &&
        (query.draft === undefined || normalized.draft === query.draft)
      )
        data.push(normalized);
      state.offsets[selected.index]++;
      // Avoid fetching beyond the requested page, especially at GitHub's search ceiling.
      if (data.length < query.limit)
        heads[selected.index] = await head(selected.index);
    }
    const hasMore = queries.some((_, index) => {
      const result = pages.get(
        `${index}:${Math.floor(Math.max(0, state.offsets[index] - 1) / 100) + 1}`,
      );
      return result
        ? state.offsets[index] < result.total_count
        : heads[index] !== null;
    });
    return {
      data,
      pagination: {
        nextCursor: hasMore
          ? await this.tokens.seal("combined-pulls", state)
          : null,
        hasMore,
      },
    };
  }

  async overview(repositoryId?: string) {
    const repos = await this.inventory(repositoryId);
    const queries = this.searchQueries(repos, { state: "open" });
    const counts = await Promise.all(
      queries.map(async (q) => {
        const response = await this.client.get(
          "/search/issues",
          searchResponse,
          { q, per_page: 1 },
        );
        return response.data.incomplete_results
          ? null
          : response.data.total_count;
      }),
    );
    const recent = await this.combinedPulls(repos, {
      state: "all",
      sort: "updated",
      direction: "desc",
      limit: 5,
    });
    return {
      data: {
        repositoryCount: repos.length,
        openPullRequestCount: counts.some((value) => value === null)
          ? null
          : counts.reduce<number>((sum, value) => sum + (value ?? 0), 0),
        reviewMetrics: null,
        recentPullRequests: recent.data,
        lastSyncedAt: null,
      },
    };
  }
}
