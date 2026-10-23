import { EncryptJWT, jwtDecrypt } from "jose";
import { z } from "zod";
import { ApiError } from "../api-error";

export class OpaqueTokens {
  constructor(
    private secret: string,
    private userId: string,
  ) {}

  private async key(purpose: string) {
    return new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`openreview:github:${purpose}:${this.secret}`),
      ),
    );
  }

  async seal(purpose: string, data: Record<string, unknown>) {
    return new EncryptJWT({ data })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
      .setIssuer("openreview")
      .setAudience(purpose)
      .setSubject(this.userId)
      .setIssuedAt()
      .setExpirationTime("15m")
      .encrypt(await this.key(purpose));
  }

  async open<T>(
    purpose: string,
    token: string,
    schema: z.ZodType<T>,
  ): Promise<T> {
    try {
      if (token.length > 16_384) throw new Error("Invalid token");
      const { payload } = await jwtDecrypt(token, await this.key(purpose), {
        issuer: "openreview",
        audience: purpose,
        subject: this.userId,
        keyManagementAlgorithms: ["dir"],
        contentEncryptionAlgorithms: ["A256GCM"],
      });
      return schema.parse(payload.data);
    } catch {
      throw new ApiError(
        400,
        "INVALID_CURSOR",
        "The cursor or installation state is invalid or expired. Start again.",
      );
    }
  }
}

export async function fingerprint(value: unknown) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(value)),
    ),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().min(1).max(16_384).optional(),
});
export const booleanQuery = z
  .enum(["true", "false"])
  .transform((value) => value === "true");
export const repositoryQuery = pageQuery.extend({
  installationId: z.string().regex(/^\d+$/).optional(),
  search: z.string().trim().max(100).optional(),
  archived: booleanQuery.optional(),
});
export const pullQuery = pageQuery.extend({
  limit: z.coerce.number().int().min(1).max(30).default(30),
  repositoryId: z.string().regex(/^\d+$/).optional(),
  state: z.enum(["open", "closed", "merged", "all"]).default("open"),
  draft: booleanQuery.optional(),
  sort: z.enum(["created", "updated"]).default("updated"),
  direction: z.enum(["asc", "desc"]).default("desc"),
});
export type RepositoryQuery = z.infer<typeof repositoryQuery>;
export type PullQuery = z.infer<typeof pullQuery>;
