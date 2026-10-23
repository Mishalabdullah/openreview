import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Config } from "../config/env";
import type { Database } from "../db";
import * as schema from "../db/auth-schema";
import { authOptions } from "./auth-options";

export function createAuth(config: Config, db: Database) {
  return betterAuth({
    ...authOptions(config),
    database: drizzleAdapter(db, { provider: "pg", schema, transaction: true }),
  });
}

export type Auth = ReturnType<typeof createAuth>;
