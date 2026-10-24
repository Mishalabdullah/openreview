import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import { member } from "../db/auth-schema";
import type { AppEnv } from "../types/env";

type OrganizationPermissions = {
  organization?: ("update" | "delete")[];
  member?: ("create" | "update" | "delete")[];
  invitation?: ("create" | "cancel")[];
  team?: ("create" | "update" | "delete")[];
};

// Call only after requireAuth. Active organization IDs are not authorization.
export async function requireOrganizationPermission(
  c: Context<AppEnv>,
  organizationId: string,
  permissions?: OrganizationPermissions,
) {
  const [membership] = await c.var.db
    .select()
    .from(member)
    .where(
      and(
        eq(member.organizationId, organizationId),
        eq(member.userId, c.var.user.id),
      ),
    )
    .limit(1);
  if (!membership) throw new HTTPException(403, { message: "Forbidden" });

  if (permissions) {
    const result = await c.var.auth.api.hasPermission({
      headers: c.req.raw.headers,
      body: { organizationId, permissions },
    });
    if (!result.success) throw new HTTPException(403, { message: "Forbidden" });
  }
  return membership;
}
