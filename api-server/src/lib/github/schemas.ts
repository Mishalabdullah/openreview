import { z } from "zod";

export const id = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative().safe()])
  .transform(String);
const nullableString = z
  .string()
  .nullish()
  .transform((value) => value ?? null);
const timestamp = nullableString.transform((value) =>
  value && !Number.isNaN(Date.parse(value))
    ? new Date(value).toISOString()
    : null,
);
export const githubUser = z.object({
  id,
  login: z.string(),
  avatar_url: nullableString,
  html_url: nullableString,
});
export const installation = z.object({
  id,
  account: z.object({ login: z.string(), type: nullableString }).nullable(),
  repository_selection: z.enum(["all", "selected"]),
  suspended_at: nullableString,
});
export const installationsResponse = z.object({
  total_count: z.number().int(),
  installations: z.array(installation),
});
export const repository = z.object({
  id,
  name: z.string(),
  full_name: z.string(),
  owner: z.object({ login: z.string(), avatar_url: nullableString }),
  description: nullableString,
  html_url: nullableString,
  visibility: z.enum(["public", "private", "internal"]).optional(),
  private: z.boolean(),
  default_branch: nullableString,
  language: nullableString,
  archived: z.boolean(),
  updated_at: timestamp,
  permissions: z
    .object({
      pull: z.boolean().optional(),
      push: z.boolean().optional(),
      admin: z.boolean().optional(),
    })
    .optional(),
});
export const repositoriesResponse = z.object({
  total_count: z.number().int(),
  repositories: z.array(repository),
});
export const pullRequest = z.object({
  id,
  number: z.number().int().positive(),
  title: z.string(),
  html_url: nullableString,
  state: z.enum(["open", "closed"]),
  draft: z.boolean().nullish(),
  user: githubUser.nullable(),
  head: z.object({ ref: nullableString, sha: nullableString }),
  base: z.object({ ref: nullableString, sha: nullableString }),
  labels: z.array(z.object({ name: z.string(), color: nullableString })),
  created_at: timestamp,
  updated_at: timestamp,
  closed_at: timestamp,
  merged_at: timestamp,
  body: nullableString,
  additions: z.number().int().optional(),
  deletions: z.number().int().optional(),
  changed_files: z.number().int().optional(),
  mergeable: z.boolean().nullish(),
});
export const searchResponse = z.object({
  total_count: z.number().int().nonnegative(),
  incomplete_results: z.boolean(),
  items: z.array(
    z.object({
      id,
      number: z.number().int().positive(),
      repository_url: z.string(),
      created_at: z.string(),
      updated_at: z.string(),
      pull_request: z.object({ url: z.string() }),
    }),
  ),
});
export const file = z.object({
  filename: z.string(),
  previous_filename: nullableString,
  status: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  patch: nullableString,
});

export type Installation = z.infer<typeof installation>;
export type Repository = z.infer<typeof repository> & {
  installationId: string;
};
export type PullRequest = z.infer<typeof pullRequest>;

export function mapRepository(repo: Repository) {
  return {
    id: repo.id,
    installationId: repo.installationId,
    name: repo.name,
    fullName: repo.full_name,
    owner: { login: repo.owner.login, avatarUrl: repo.owner.avatar_url },
    description: repo.description,
    htmlUrl: repo.html_url,
    visibility: repo.visibility ?? (repo.private ? "private" : "public"),
    defaultBranch: repo.default_branch,
    language: repo.language,
    archived: repo.archived,
    updatedAt: repo.updated_at,
    permissions: {
      canRead: repo.permissions?.pull ?? true,
      canWrite: repo.permissions?.push ?? false,
      canAdmin: repo.permissions?.admin ?? false,
    },
  };
}

export function mapPullRequest(pr: PullRequest, repo: Repository) {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    htmlUrl: pr.html_url,
    state: pr.merged_at ? "merged" : pr.state,
    draft: pr.draft ?? false,
    repository: { id: repo.id, name: repo.name, fullName: repo.full_name },
    author: pr.user
      ? { id: pr.user.id, login: pr.user.login, avatarUrl: pr.user.avatar_url }
      : null,
    head: pr.head,
    base: pr.base,
    labels: pr.labels.map((label) => ({
      name: label.name,
      color: label.color,
    })),
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    closedAt: pr.closed_at,
    mergedAt: pr.merged_at,
    appReview: null,
  };
}
