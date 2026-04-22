import { reportQueueMarker } from "../../../_shared/queue-test"

export default defineQueue<{ callbackUrl?: string, email: string, marker?: string }>(async (job) => {
  await reportQueueMarker(job.payload.marker, job.payload.callbackUrl)
})
