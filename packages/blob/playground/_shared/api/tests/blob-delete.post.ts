import { defineEventHandler } from "h3"
import { blob } from "@vitehub/blob"

export default defineEventHandler(async (event) => {
  const request = event as typeof event & { req?: { url?: string } }
  const url = request.req?.url || event.node?.req?.url || "/"
  const requestURL = new URL(url, "http://localhost")
  await blob.del(requestURL.searchParams.getAll("pathname"))
  return { ok: true }
})
