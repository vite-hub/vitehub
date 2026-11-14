import { lte } from "drizzle-orm"
import { db } from "vite-hub/database"
import { codeImages } from "../databases/config"
import { defineSchedule } from "vite-hub/schedule"

/** The hourly cleanup of expired code images. */
export default defineSchedule("0 * * * *", async ({ scheduledAt }) => {
  await db.delete(codeImages).where(lte(codeImages.expiresAt, scheduledAt.getTime()))
}, { manual: true })
