import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { member, organization } from '../db/auth-schema'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types/env'

export const me = new Hono<AppEnv>()
me.use('*', requireAuth)

me.get('/', (c) => {
  const { id, name, email, emailVerified, image, createdAt, updatedAt } = c.var.user
  return c.json({ user: { id, name, email, emailVerified, image, createdAt, updatedAt } })
})

me.get('/organizations', async (c) => {
  // Same membership-based listing as Better Auth, using the already validated user
  // to avoid a second session read. All mutations stay in the organization plugin.
  const rows = await c.var.db.select({ organization }).from(organization)
    .innerJoin(member, and(
      eq(member.organizationId, organization.id),
      eq(member.userId, c.var.user.id),
    ))
  return c.json({ organizations: rows.map((row) => row.organization) })
})
