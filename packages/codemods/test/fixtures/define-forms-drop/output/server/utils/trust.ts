import { and, eq, exists, inArray } from "drizzle-orm"
import type { H3Event } from "h3"
import { db } from "vite-hub/database/drizzle"
import { useServerEnv } from "vite-hub/env"
import { abuseReports, user } from "../databases/default/index"
import { needsShareReview, reportTarget } from "#shared/trust"

export async function shareReviewFor(ownerId: string, event?: H3Event, joinedOwner?: typeof user.$inferSelect | null) {
  if (!useServerEnv(event).drop.shareApproval) return null
  const owner =
    joinedOwner !== undefined ? joinedOwner : (await db.select().from(user).where(eq(user.id, ownerId)).limit(1))[0]
  return needsShareReview(true, owner ?? undefined) ? ("pending" as const) : null
}
