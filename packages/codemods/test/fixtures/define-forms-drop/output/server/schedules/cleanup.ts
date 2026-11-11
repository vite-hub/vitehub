import { lte } from "drizzle-orm"
import { db } from "vite-hub/database"
import { codeImages } from "../databases/default/index"
import { defineSchedule } from "vite-hub/schedule"

/** The hourly cleanup of expired code images. */
export default defineSchedule({ cron: "0 * * * *", manual: true, handler: async ({ scheduledAt }) => {
  await db.delete(codeImages).where(lte(codeImages.expiresAt, scheduledAt.getTime()))
} })
