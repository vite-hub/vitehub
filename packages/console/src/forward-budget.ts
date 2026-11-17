import { sql } from "drizzle-orm"
import { authSqliteSchema } from "vite-hub/auth/schema"

import type { ConsoleDatabase } from "./projects.ts"

const { rateLimit } = authSqliteSchema

/**
 * The signed calls that one person can send to one project in a minute, through the Console page, an API key, or the
 * ViteHub MCP. The Console page follows logs with one call every 2 seconds, so normal use stays far below it.
 */
export const forwardBudget = { limit: 600, windowMs: 60_000 }

/**
 * Count one signed call of a person to a project in a fixed window. It returns the seconds until the window ends when
 * the call is over the budget, else `undefined`. The count lives in Better Auth's `rate_limit` table, so every server
 * process sees it. One upsert reads and writes the row, so two calls at the same time cannot both take the last one.
 * `last_request` holds the start of the window.
 */
export async function consumeForwardBudget(db: ConsoleDatabase, userId: string, projectId: string, now = Date.now()): Promise<number | undefined> {
  const { limit, windowMs } = forwardBudget
  const expired = sql`${rateLimit.lastRequest} <= ${now - windowMs}`
  const [row] = await db.insert(rateLimit)
    .values({ count: 1, id: crypto.randomUUID(), key: `console-forward:${userId}:${projectId}`, lastRequest: now })
    .onConflictDoUpdate({
      set: {
        count: sql`case when ${expired} then 1 else ${rateLimit.count} + 1 end`,
        lastRequest: sql`case when ${expired} then ${now} else ${rateLimit.lastRequest} end`,
      },
      target: rateLimit.key,
    })
    .returning({ count: rateLimit.count, start: rateLimit.lastRequest })
  // The Auth schema types its columns loosely, so the numbers are read as numbers here.
  const count = Number(row?.count)
  if (count <= limit) return undefined
  return Math.max(1, Math.ceil((Number(row?.start) + windowMs - now) / 1000))
}
