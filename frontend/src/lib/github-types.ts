export type Pagination = { nextCursor: string | null; hasMore: boolean };
export type Page<T> = { data: T[]; pagination: Pagination };
export type Envelope<T> = { data: T };
export type GitHubAccount = {
  id: string;
  login: string;
  avatarUrl: string | null;
  htmlUrl: string | null;
};
export type Installation = {
  id: string;
  accountLogin: string | null;
  accountType: string | null;
  repositorySelection: "all" | "selected";
  suspended: boolean;
};
export type Connection = {
  status:
    | "connected"
    | "installation_required"
    | "reauthorization_required"
    | "disconnected";
  account: GitHubAccount | null;
  installations: Installation[];
  installUrl: string | null;
  lastSyncedAt: string | null;
};
export type ConnectionResponse = Envelope<Connection> & {
  pagination: Pagination;
};
export type Repository = {
  id: string;
  installationId: string;
  name: string;
  fullName: string;
  owner: { login: string; avatarUrl: string | null };
  description: string | null;
  htmlUrl: string | null;
  visibility: "public" | "private" | "internal";
  defaultBranch: string | null;
  language: string | null;
  archived: boolean;
  updatedAt: string | null;
  permissions: { canRead: boolean; canWrite: boolean; canAdmin: boolean };
};
export type PullRequest = {
  id: string;
  number: number;
  title: string;
  htmlUrl: string | null;
  state: "open" | "closed" | "merged";
  draft: boolean;
  repository: { id: string; name: string; fullName: string };
  author: GitHubAccount | null;
  head: { ref: string | null; sha: string | null };
  base: { ref: string | null; sha: string | null };
  labels: { name: string; color: string | null }[];
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  mergedAt: string | null;
  appReview: null;
};
export type Overview = {
  repositoryCount: number | null;
  openPullRequestCount: number | null;
  reviewMetrics: null;
  recentPullRequests: PullRequest[];
  lastSyncedAt: string | null;
};
export type RepositoryFilters = {
  installationId?: string;
  search?: string;
  archived?: "true" | "false";
};
export type PullFilters = {
  repositoryId?: string;
  state: "open" | "closed" | "merged" | "all";
  draft?: "true" | "false";
  sort: "created" | "updated";
  direction: "asc" | "desc";
};
