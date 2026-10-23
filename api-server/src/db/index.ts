import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { databaseUrl } from "../config/env";
import type { Bindings } from "../types/env";
import * as schema from "./auth-schema";

export function createDatabase(bindings: Bindings) {
  // One lazy connection per request; Hyperdrive owns the regional origin pool.
  const pool = new Pool({
    connectionString: databaseUrl(bindings),
    max: 1,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
  });
  pool.on("error", () => {
    console.error(JSON.stringify({ event: "database_connection_error" }));
  });
  return {
    db: drizzle(pool, { schema }),
    close: () => pool.end(),
  };
}

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;
