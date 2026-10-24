import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { databaseUrl } from "../config/env";
import type { Bindings } from "../types/env";
import * as schema from "./auth-schema";

export function createDatabase(bindings: Bindings) {
  // One lazy direct PostgreSQL connection per request/queue invocation.
  // Never share a pool across Worker invocations; close it in the caller's finally.
  const pool = new Pool({
    connectionString: databaseUrl(bindings),
    max: 1,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
  });
  let closing = false;
  pool.on("error", (error) => {
    const code =
      "code" in error &&
      typeof error.code === "string" &&
      [
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "ENOTFOUND",
        "28P01",
        "53300",
        "57P01",
      ].includes(error.code)
        ? error.code
        : "UNKNOWN";
    const reason = /Connection terminated unexpectedly/i.test(error.message)
      ? "connection_terminated"
      : /closed|closing/i.test(error.message)
        ? "connection_closed"
        : "other";
    if (closing && reason === "connection_closed") {
      // Some pg-cloudflare socket implementations emit a close error while end()
      // drains an already-closed stream. Distinguish it from a failed live query.
      console.warn(
        JSON.stringify({ event: "database_cleanup_notice", code, reason }),
      );
      return;
    }
    console.error(
      JSON.stringify({
        event: "database_connection_error",
        phase: closing ? "cleanup" : "request",
        code,
        reason,
      }),
    );
  });
  return {
    db: drizzle(pool, { schema }),
    close: () => {
      closing = true;
      return pool.end();
    },
  };
}

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;
