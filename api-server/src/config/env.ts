import { z } from "zod";
import type { Bindings } from "../types/env";

const origin = z.url().refine((value) => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && url.origin === value;
}, "Must be an exact HTTP(S) origin without a trailing slash, path or credentials");

const configSchema = z
  .object({
    ENVIRONMENT: z.enum(["local", "dev", "production"]),
    BETTER_AUTH_URL: origin,
    FRONTEND_URL: origin,
    BETTER_AUTH_SECRET: z.string().min(32),
    GITHUB_CLIENT_ID: z.string().min(1),
    GITHUB_CLIENT_SECRET: z.string().min(1),
    GITHUB_WEBHOOK_SECRET: z.string().min(1),
    GITHUB_APP_SLUG: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional(),
  })
  .superRefine((env, ctx) => {
    const expected = {
      local: ["http://localhost:1337", "http://localhost:5173"],
      dev: ["https://api.dev.openreview.si", "https://dev.openreview.si"],
      production: ["https://api.openreview.si", "https://openreview.si"],
    }[env.ENVIRONMENT];
    for (const [index, key] of ["BETTER_AUTH_URL", "FRONTEND_URL"].entries()) {
      if (env[key as "BETTER_AUTH_URL" | "FRONTEND_URL"] !== expected[index]) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Origin does not match environment",
        });
      }
    }
  });

export type Config = z.infer<typeof configSchema>;

export function readConfig(bindings: Bindings): Config {
  const result = configSchema.safeParse(bindings);
  if (!result.success) {
    // Do not include Zod input values or credentials in errors/logs.
    throw new Error("Invalid backend environment configuration");
  }
  return result.data;
}

export function databaseUrl(bindings: Bindings): string {
  if (bindings.HYPERDRIVE?.connectionString)
    return bindings.HYPERDRIVE.connectionString;
  if (bindings.ENVIRONMENT === "local" && bindings.DATABASE_URL) {
    const result = z.url().safeParse(bindings.DATABASE_URL);
    if (result.success && /^postgres(ql)?:/.test(result.data))
      return result.data;
  }
  throw new Error("Database binding is not configured");
}
