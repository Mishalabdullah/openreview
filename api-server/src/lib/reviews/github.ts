import { createPrivateKey } from "node:crypto";
import { Buffer } from "node:buffer";
import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";
import { id, pullRequest, repository } from "../github/schemas";
import { ReviewFailure } from "./config";
import { boundedJson, type ReviewResult } from "./model";

export class AppGitHub {
  private calls = 0;
  constructor(
    private token: string,
    private fetcher: typeof fetch = fetch,
  ) {}

  async request<T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    method?: "DELETE",
  ): Promise<{ data: T; hasNext: boolean }> {
    if (++this.calls > 40 || !path.startsWith("/") || path.startsWith("//"))
      throw new ReviewFailure("GITHUB_REQUEST_BUDGET");
    const url = new URL(path, "https://api.github.com");
    if (url.origin !== "https://api.github.com")
      throw new ReviewFailure("INVALID_GITHUB_DESTINATION");
    let response: Response;
    try {
      response = await this.fetcher.call(globalThis, url.href, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          "User-Agent": "OpenReview",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ReviewFailure("GITHUB_UNAVAILABLE", true);
    }
    if (!response.ok) {
      const limited =
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.has("Retry-After") ||
            response.headers.get("X-RateLimit-Remaining") === "0"));
      await response.body?.cancel();
      throw new ReviewFailure(
        limited
          ? "GITHUB_RATE_LIMITED"
          : response.status === 404 ||
              response.status === 403 ||
              response.status === 401
            ? "GITHUB_ACCESS_DENIED"
            : "GITHUB_REQUEST_FAILED",
        limited || response.status >= 500,
      );
    }
    const parsed = schema.safeParse(
      response.status === 204 ? undefined : await boundedJson(response),
    );
    if (!parsed.success) throw new ReviewFailure("GITHUB_INVALID_RESPONSE");
    return {
      data: parsed.data,
      hasNext: /rel="next"/.test(response.headers.get("Link") ?? ""),
    };
  }
}

export async function installationClient(
  config: { appId: string; privateKey: string },
  installationId: string,
  fetcher?: typeof fetch,
) {
  let key: CryptoKey;
  try {
    key = await importPKCS8(
      createPrivateKey(config.privateKey)
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
      "RS256",
    );
  } catch {
    throw new ReviewFailure("GITHUB_APP_KEY_INVALID");
  }
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(config.appId)
    .setIssuedAt(Math.floor(Date.now() / 1000) - 60)
    .setExpirationTime("9m")
    .sign(key);
  const app = new AppGitHub(jwt, fetcher);
  const installation = (
    await app.request(
      `/app/installations/${installationId}`,
      z.object({ id, suspended_at: z.string().nullable() }),
    )
  ).data;
  if (installation.id !== installationId || installation.suspended_at)
    throw new ReviewFailure("INSTALLATION_UNAVAILABLE");
  const token = await app.request(
    `/app/installations/${installationId}/access_tokens`,
    z.object({ token: z.string() }),
    {},
  );
  return new AppGitHub(token.data.token, fetcher);
}

export const repoPath = (fullName: string) =>
  `/repos/${fullName.split("/").map(encodeURIComponent).join("/")}`;
export const pullPath = (fullName: string, number: number) =>
  `${repoPath(fullName)}/pulls/${number}`;

// The opening PR description uses GitHub's issue-reactions endpoint, not comments.
export async function addReviewEyes(
  client: AppGitHub,
  fullName: string,
  number: number,
) {
  return (
    await client.request(
      `${repoPath(fullName)}/issues/${number}/reactions`,
      z.object({ id }),
      { content: "eyes" },
    )
  ).data.id;
}

export async function removeReviewEyes(
  client: AppGitHub,
  fullName: string,
  number: number,
  reactionId: string,
) {
  await client.request(
    `${repoPath(fullName)}/issues/${number}/reactions/${encodeURIComponent(reactionId)}`,
    z.undefined(),
    undefined,
    "DELETE",
  );
}

/** Added new-side lines only: invalid model locations stay in the summary. */
export function addedLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let current: number | null = null;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      current = Number(hunk[1]);
      continue;
    }
    if (current === null || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      lines.add(current++);
    } else if (line.startsWith(" ")) current++;
  }
  return lines;
}

const changedFile = z.object({
  filename: z.string(),
  status: z.string(),
  patch: z.string().nullish(),
});
export async function reviewInput(
  client: AppGitHub,
  fullName: string,
  number: number,
  sha: string,
  repositoryId: string,
) {
  const repo = (await client.request(repoPath(fullName), repository)).data;
  if (repo.id !== repositoryId || repo.archived)
    throw new ReviewFailure("REPOSITORY_UNAVAILABLE");
  const pr = (await client.request(pullPath(fullName, number), pullRequest))
    .data;
  if (pr.head.sha !== sha) throw new ReviewFailure("SUPERSEDED");
  if (pr.state !== "open" || pr.draft)
    throw new ReviewFailure("PR_NOT_REVIEWABLE");
  const response = await client.request(
    `${pullPath(fullName, number)}/files?per_page=100&page=1`,
    z.array(changedFile),
  );
  const locations = new Map<string, Set<number>>();
  const files: { path: string; patch: string; source?: string }[] = [];
  const limitations: string[] = [];
  if (response.hasNext || (pr.changed_files ?? 0) > response.data.length)
    limitations.push("Only the first 100 changed files were considered.");
  let budget = 90_000;
  for (const file of response.data) {
    if (
      /(?:^|\/)(?:\.env[^/]*|id_rsa|id_ed25519|[^/]+\.(?:pem|key|p12|pfx))$/i.test(
        file.filename,
      )
    ) {
      if (
        !limitations.includes("Secret/configuration key files were excluded.")
      )
        limitations.push("Secret/configuration key files were excluded.");
      continue;
    }
    if (!file.patch) {
      if (
        !limitations.includes(
          "Some binary or unavailable patches were not reviewed.",
        )
      )
        limitations.push(
          "Some binary or unavailable patches were not reviewed.",
        );
      continue;
    }
    if (file.patch.length > budget) {
      if (!limitations.includes("The bounded diff budget excluded some files."))
        limitations.push("The bounded diff budget excluded some files.");
      continue;
    }
    budget -= file.patch.length;
    locations.set(file.filename, addedLines(file.patch));
    files.push({ path: file.filename, patch: file.patch });
  }
  if (!files.length) throw new ReviewFailure("NO_REVIEWABLE_DIFF");
  // Supplement the diff with bounded current-source context. Never execute it.
  for (const file of files.slice(0, 5)) {
    if (!budget || !locations.get(file.path)?.size) continue;
    let content: { encoding: string; content?: string; size: number };
    try {
      content = (
        await client.request(
          `${repoPath(fullName)}/contents/${file.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(sha)}`,
          z.object({
            encoding: z.string(),
            content: z.string().optional(),
            size: z.number(),
          }),
        )
      ).data;
    } catch (error) {
      if (
        !(error instanceof ReviewFailure) ||
        error.code !== "GITHUB_ACCESS_DENIED"
      )
        throw error;
      if (
        !limitations.includes(
          "Some source context was unavailable; only the supplied patches were reviewed.",
        )
      )
        limitations.push(
          "Some source context was unavailable; only the supplied patches were reviewed.",
        );
      continue;
    }
    if (
      content.encoding === "base64" &&
      content.content &&
      content.size <= Math.min(budget, 20_000)
    ) {
      const source = Buffer.from(content.content, "base64").toString("utf8");
      if (!source.includes("\u0000") && source.length <= budget) {
        file.source = source;
        budget -= source.length;
      }
    }
  }
  limitations.push(
    "Review is limited to available patches and up to five bounded source files; tests were not executed.",
  );
  return {
    input: { title: pr.title, commit: sha, files },
    locations,
    limitations,
  };
}

const review = z.object({
  id,
  html_url: z.string(),
  body: z.string().nullable(),
  commit_id: z.string().nullable(),
  user: z.object({ login: z.string(), type: z.string() }).nullable(),
});
const safeText = (value: string) =>
  value.replace(/<!--/g, "").replace(/@/g, "＠");
export async function publishReview(
  client: AppGitHub,
  run: { id: string; fullName: string; pullNumber: number; headSha: string },
  result: ReviewResult,
  slug: string,
  locations: Map<string, Set<number>>,
) {
  const marker = `<!-- openreview:${run.id}:${run.headSha} -->`;
  // Reconcile before POST, including after an ambiguous timeout/DB failure.
  for (let page = 1; page <= 10; page++) {
    const existing = await client.request(
      `${pullPath(run.fullName, run.pullNumber)}/reviews?per_page=100&page=${page}`,
      z.array(review),
    );
    const found = existing.data.find(
      (item) =>
        item.body?.includes(marker) &&
        item.commit_id === run.headSha &&
        item.user?.type === "Bot" &&
        item.user.login === `${slug}[bot]`,
    );
    if (found) return found;
    if (!existing.hasNext) break;
    if (page === 10) throw new ReviewFailure("REVIEW_RECONCILIATION_LIMIT");
  }
  const latest = (
    await client.request(pullPath(run.fullName, run.pullNumber), pullRequest)
  ).data;
  if (latest.head.sha !== run.headSha) throw new ReviewFailure("SUPERSEDED");
  if (latest.state !== "open" || latest.draft)
    throw new ReviewFailure("PR_NOT_REVIEWABLE");
  const comments = result.findings
    .filter((finding) => locations.get(finding.path)?.has(finding.line))
    .map((finding) => ({
      path: finding.path,
      line: finding.line,
      side: "RIGHT",
      body: safeText(
        `**${finding.severity.toUpperCase()}: ${finding.title}**\n\n${finding.description}`,
      ),
    }));
  const findings = result.findings
    .map(
      (finding) =>
        `- **${safeText(finding.severity)}: ${safeText(finding.title)}** — \`${safeText(finding.path).replace(/`/g, "")}:${finding.line}\`\n  ${safeText(finding.description)}`,
    )
    .join("\n");
  return (
    await client.request(
      `${pullPath(run.fullName, run.pullNumber)}/reviews`,
      review,
      {
        commit_id: run.headSha,
        event: "COMMENT",
        comments,
        body: `${marker}\n## OpenReview\n\n${safeText(result.summary)}\n\n${findings || "No actionable findings in the reviewed scope."}\n\n### Coverage\n${result.limitations.map((value) => `- ${safeText(value)}`).join("\n")}\n\nReviewed commit: \`${run.headSha}\`. AI-generated suggestions; human verification is required.`,
      },
    )
  ).data;
}
