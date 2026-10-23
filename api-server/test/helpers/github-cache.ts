import type { GitHubCacheStore } from "../../src/lib/github/cache";

export function memoryGitHubCache() {
  const entries = new Map<string, Response>();
  const store: GitHubCacheStore = {
    match: async (request) => entries.get(new Request(request).url)?.clone(),
    put: async (request, response) => {
      entries.set(new Request(request).url, response.clone());
    },
  };
  return { store, entries };
}
