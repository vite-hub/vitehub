import { defineEventHandler, getQuery } from "h3"

import { blob } from "@vitehub/blob"

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  return await blob.list({
    folded: query.folded === "true",
    limit: typeof query.limit === "string" ? Number.parseInt(query.limit, 10) : undefined,
    prefix: typeof query.prefix === "string" ? query.prefix : undefined,
  })
})
