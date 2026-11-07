import { and, eq, gt, inArray, isNotNull, like, lt, lte, notInArray, type SQL } from "drizzle-orm"
import { createLogger, type RequestLogger } from "evlog"
import { db } from "vite-hub/database/drizzle"
import { defineSchedule } from "vite-hub/schedule"
import { dispatchSync } from "#dispatch"
import { isLocale, FORMAT_LOCALES } from "../../shared/locale"
import { translator } from "../utils/translate"
import { send } from "#mailer"
import { connection, householdSettings, user as users } from "../databases/config"
import { isDemo } from "../demo/mode"
import { seedDemo } from "../demo/seed"
import { errorMessage, knownOrigin } from "../utils/connections"
import { revalueManualHoldings } from "../utils/holdings"
import { detectTransfers } from "../utils/transfers"
import { DEMO_DOMAIN } from "../../shared/demo"

const DAY = 24 * 60 * 60 * 1000

/**
 * Every morning: expire consents that ran out, remind owners a week before one does, drop bank links nobody finished,
 * price what manual accounts hold, then sync every active (or failed) connection one at a time. One failure never
 * stops the rest.
 *
 * The demo (`FINANCE_DEMO=1`) first rebuilds the demo household as of today, wiping whatever visitors changed
 * as Lucía and Pablo. The demo's connections are fakes: they never sync, expire, or get reminders.
 *
 * The run is one wide event (`action: "schedule"`) with what it did and each step that failed; every sync it starts
 * inline (Node) logs its own.
 */
export default defineSchedule({
  cron: "0 5 * * *",
  // Lets an operator run it now from the ViteHub Console or `vitehub schedule run daily`.
  manual: true,
  async handler({ scheduledAt }) {
    const log = createLogger({ action: "schedule", schedule: { name: "daily", scheduledAt: scheduledAt.toISOString() } })
    try {
      return await daily(scheduledAt, log)
    } catch (error) {
      log.error(error instanceof Error ? error : new Error(errorMessage(error)))
      throw error
    } finally {
      log.emit()
    }
  },
})

async function daily(scheduledAt: Date, log: RequestLogger) {
  const now = scheduledAt.getTime()
  const errors: unknown[] = []
  const step = async (run: () => Promise<unknown>) => run().catch((error) => errors.push(error))

  // Only the demo's people: seedDemo wipes by their emails and households nobody else is in (server/utils/erase.ts).
  let real: SQL | undefined
  if (isDemo()) {
    await step(() => seedDemo(scheduledAt.toISOString().slice(0, 10)))
    const demoPeople = await db.select({ id: users.id }).from(users).where(like(users.email, `%@${DEMO_DOMAIN}`))
    if (demoPeople.length) real = notInArray(connection.ownerId, demoPeople.map((row) => row.id))
    log.set({ schedule: { demo: true } })
  }

  await step(() =>
    db
      .update(connection)
      .set({ status: "expired", lastError: "The bank consent has expired. Reconnect the bank to keep syncing.", lastErrorCode: "providerExpired" })
      .where(and(eq(connection.status, "active"), isNotNull(connection.consentExpiresAt), lte(connection.consentExpiresAt, new Date(now)), real)),
  )

  await step(async () => {
    const origin = await knownOrigin()
    const expiring = await db
      .select({ id: connection.id, name: connection.name, until: connection.consentExpiresAt, remindedAt: connection.remindedAt, email: users.email, language: users.language })
      .from(connection)
      .innerJoin(users, eq(users.id, connection.ownerId))
      .where(
        and(
          eq(connection.status, "active"),
          gt(connection.consentExpiresAt, new Date(now)),
          lte(connection.consentExpiresAt, new Date(now + 7 * DAY)),
          real,
        ),
      )
    for (const row of expiring) {
      if (row.remindedAt && now - row.remindedAt.getTime() < 6 * DAY) continue
      const language = isLocale(row.language) ? row.language : "en"
      const t = await translator(language)
      const until = language === "en" ? row.until!.toISOString().slice(0, 10) : new Intl.DateTimeFormat(FORMAT_LOCALES[language], { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(row.until!)
      await step(async () => {
        await send({
          to: row.email,
          subject: t("emailReconnectSubject", { name: row.name }),
          text: [
            t("emailReconnectBody", { name: row.name, date: until }),
            origin ? t("emailReconnectLink", { url: `${origin}/connect/banks` }) : t("emailReconnectNoLink"),
          ].join("\n\n"),
        })
        await db.update(connection).set({ remindedAt: new Date(now) }).where(eq(connection.id, row.id))
      })
    }
  })

  // Bank links abandoned at the consent screen, so they don't linger as "pending" forever.
  await step(() =>
    db.delete(connection).where(and(eq(connection.status, "pending"), lt(connection.createdAt, new Date(now - DAY)), real)),
  )

  // Pairs moves between accounts again, so rows imported or recategorized since yesterday can still pair.
  for (const { householdId } of await db.select({ householdId: householdSettings.householdId }).from(householdSettings))
    await step(() => detectTransfers(householdId))

  // Silver and other assets typed into a manual account follow today's price.
  await step(() => revalueManualHoldings())

  // Connections in `error` retry too: most errors (a bank or an API down) pass. Expired ones wait for their owner.
  const active = await db.select({ id: connection.id }).from(connection).where(and(inArray(connection.status, ["active", "error"]), real))
  for (const { id } of active) await step(() => dispatchSync(id, "schedule"))

  log.set({ schedule: { dispatched: active.length, failures: errors.length } })
  // One failure never stops the run, and the run itself succeeds; the event says what failed.
  if (errors.length)
    log.error(new AggregateError(errors, `${errors.length} step(s) failed: ${errors.map(errorMessage).join("; ").slice(0, 900)}`))
  return { synced: active.length, failures: errors.length }
}
