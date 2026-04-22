import { createError, defineEventHandler, getQuery } from "h3"

import { blob } from "@vitehub/blob"

export default defineEventHandler(async (event) => {
  const pathname = getQuery(event).pathname
  if (typeof pathname !== "string" || pathname.length === 0) {
    throw createError({ statusCode: 400, statusMessage: "Missing pathname" })
  }

  const file = await blob.get(pathname)
  return {
    ok: true,
    text: file ? await file.text() : null,
  }
})
