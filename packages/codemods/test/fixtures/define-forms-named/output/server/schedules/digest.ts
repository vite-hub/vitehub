import { defineSchedule } from "vite-hub/schedule"

const options = { manual: true }

export default defineSchedule({ cron: "0 7 * * 1", ...options, handler: async () => {
  await sendDigest()
} })

async function sendDigest() {}
