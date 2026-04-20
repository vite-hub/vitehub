export default defineQueue<{ email: string, marker?: string }>(async (job) => {
  if (typeof job.payload.marker === "string") {
    console.log(`[vitehub-queue-e2e] ${job.payload.marker}`)
  }
})
