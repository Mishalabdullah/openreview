import { EncryptJWT, jwtDecrypt } from "jose";
import { z } from "zod";
import { fingerprint } from "./pagination";

export type GitHubCacheStore = Pick<Cache, "match" | "put">;
export const GITHUB_CACHE_SECONDS = 30;
const MAX_BODY_BYTES = 1024 * 1024;
const envelope = z.object({
  body: z.string().max(MAX_BODY_BYTES),
  expiresAt: z.number().int(),
});

export function defaultGitHubCache(): GitHubCacheStore | undefined {
  return typeof caches === "undefined" ? undefined : caches.default;
}

/** Request-owned handle; only encrypted bytes live in the platform cache. */
export class GitHubCache {
  private freshUntil = Date.now() + GITHUB_CACHE_SECONDS * 1000;
  private readonly scope: Promise<string>;
  private readonly key: Promise<Uint8Array>;
  hits = 0;

  constructor(
    private store: GitHubCacheStore | undefined,
    secret: string,
    private origin: string,
    userId: string,
    accountId: string,
    accessToken: string,
    private bypass = false,
  ) {
    // Domain-separated secret hashes keep identifiers/tokens out of cache keys.
    this.scope = fingerprint([
      "github-cache-v1",
      secret,
      origin,
      userId,
      accountId,
      accessToken,
    ]);
    this.key = crypto.subtle
      .digest(
        "SHA-256",
        new TextEncoder().encode(`openreview:github-cache-v1:${secret}`),
      )
      .then((bytes) => new Uint8Array(bytes));
  }

  get enabled() {
    return this.store !== undefined;
  }

  get bypassed() {
    return this.bypass;
  }

  private async request(resource: string) {
    const digest = await fingerprint([await this.scope, resource]);
    // This URL is a cache key only. It is never fetched or exposed by a route.
    return new Request(`${this.origin}/__internal/github-cache/v1/${digest}`);
  }

  async read(resource: string): Promise<{ body: string; age: number } | null> {
    if (!this.store || this.bypass) return null;
    try {
      const response = await this.store.match(await this.request(resource));
      if (!response) return null;
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > MAX_BODY_BYTES * 2) return null;
      const encrypted = new TextDecoder().decode(bytes);
      const { payload } = await jwtDecrypt(encrypted, await this.key, {
        issuer: "openreview",
        audience: resource,
        subject: await this.scope,
        keyManagementAlgorithms: ["dir"],
        contentEncryptionAlgorithms: ["A256GCM"],
      });
      const value = envelope.parse(payload.data);
      const now = Date.now();
      if (
        value.expiresAt <= now ||
        value.expiresAt > now + GITHUB_CACHE_SECONDS * 1000
      )
        return null;
      // Derived API responses must never extend the lifetime of cached metadata.
      this.freshUntil = Math.min(this.freshUntil, value.expiresAt);
      this.hits++;
      return {
        body: value.body,
        age: Math.max(
          0,
          Math.floor(
            (now - (value.expiresAt - GITHUB_CACHE_SECONDS * 1000)) / 1000,
          ),
        ),
      };
    } catch {
      // Cache outages, corruption and expired entries always fall back to GitHub.
      return null;
    }
  }

  async write(resource: string, body: string) {
    if (
      !this.store ||
      new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES
    )
      return;
    try {
      const ttl = Math.floor((this.freshUntil - Date.now()) / 1000);
      if (ttl <= 0) return;
      const encrypted = await new EncryptJWT({
        data: { body, expiresAt: this.freshUntil },
      })
        .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
        .setIssuer("openreview")
        .setAudience(resource)
        .setSubject(await this.scope)
        .setExpirationTime(Math.floor(this.freshUntil / 1000))
        .encrypt(await this.key);
      await this.store.put(
        await this.request(resource),
        new Response(encrypted, {
          headers: {
            "Cache-Control": `max-age=${ttl}`,
            "Content-Type": "application/jose",
          },
        }),
      );
    } catch {
      // Never fail a successful GitHub request because a cache write failed.
    }
  }
}
