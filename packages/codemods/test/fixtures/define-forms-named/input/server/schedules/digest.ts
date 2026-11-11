import { defineSchedule } from "vite-hub/schedule"

const options = { manual: true }

export default defineSchedule("0 7 * * 1", async () => {
  await sendDigest()
}, options)

async function sendDigest() {}
