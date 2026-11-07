import { and, eq, sql } from "drizzle-orm"
import { log } from "evlog"
import type { H3Event } from "h3"
import { isbot } from "isbot"
import { db } from "vite-hub/database/drizzle"
import { useServerEnv } from "#vitehub/env/server"
import { DAY_MS, DEFAULT_EXPIRY_DAYS, expiresAt } from "#shared/expiry"
import { drops } from "../databases/config"
import type { Identity } from "./identity"

interface ExpiryPolicy {
  /** Days a `review` drop lives after its last visit (`temporary` ones get at most 14). 0 turns expiry off. */
  days: number
  /** Whether owners and their agents may keep drops. Admins always may. */
  custom: boolean
}

export function expiryPolicy(event?: H3Event): ExpiryPolicy {
  const { expiryDays, customExpiry } = useServerEnv(event).drop
  return { days: expiryDays >= 0 ? Math.floor(expiryDays) : DEFAULT_EXPIRY_DAYS, custom: customExpiry }
}

type ExpiryFields = Pick<typeof drops.$inferSelect, "createdAt" | "lastAccessedAt" | "lifetime">

export function isExpired(row: ExpiryFields, now: number, days: number) {
  const at = expiresAt(row, days)
  return at !== null && at <= now
}

/**
 * Whether an anonymous request looks like a person in a browser. Link unfurlers, crawlers, and uptime checks
 * either send a bot user agent or never run the page's script. `beacon` is the shared page's same-origin call
 * after it renders; `document` is a direct navigation to a raw file. Embedded images and hotlinks never count.
 */
export function isHumanVisit(headers: Headers, kind: "beacon" | "document") {
  const agent = headers.get("user-agent")?.trim()
  if (!agent || isbot(agent)) return false
  if (kind === "beacon") return headers.get("sec-fetch-site") === "same-origin"
  return headers.get("sec-fetch-mode") === "navigate" && headers.get("sec-fetch-dest") === "document"
}

/**
 * Restarts the drop's expiry window. People and agents who identify themselves always count; anonymous visitors
 * count when they pass `isHumanVisit`. Writes at most once a day per drop, and never revives an expired drop:
 * that takes an explicit renew. A drop in a folder, or a file a doc embeds, lives as long as the node at the top, so
 * the visit renews that one (its window is the one `row` carries, see ./nodes).
 */
export async function recordVisit(
  event: H3Event,
  row: ExpiryFields & {
    id: string
    ownerId: string
    quarantinedAt: number | null
    trashedAt: number | null
    ancestors?: { id: string; ownerId: string }[]
  },
  who: Identity | null,
  kind: "beacon" | "document",
) {
  const now = Date.now()
  const { days } = expiryPolicy(event)
  if (!days || row.lifetime === "keep" || row.trashedAt || row.quarantinedAt || isExpired(row, now, days)) return
  if ((row.lastAccessedAt ?? row.createdAt) > now - DAY_MS) return
  if (!who && !isHumanVisit(event.req.headers, kind)) return
  try {
    await renewDrop(
      row.ancestors?.at(-1) ?? row,
      now,
      sql`coalesce(${drops.lastAccessedAt}, ${drops.createdAt}) <= ${now - DAY_MS}`,
    )
  } catch (error) {
    log.error({ action: "drop-visit", error: String(error) })
  }
}

/** Starts a fresh window for the drop. */
export const renewDrop = (row: { id: string }, now = Date.now(), when = sql`1`) =>
  db
    .update(drops)
    .set({ lastAccessedAt: now })
    .where(and(eq(drops.id, row.id), when))
