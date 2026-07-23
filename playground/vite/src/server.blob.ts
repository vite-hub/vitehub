import { H3, createError, getQuery, readValidatedBody } from "h3"
import * as v from "valibot"

import { blob } from "@vite-hub/blob"

const app = new H3()
const blobPutBody = v.optional(v.object({
  pathname: v.optional(v.string()),
  value: v.optional(v.string()),
}), {})
const blobDeleteBody = v.object({
  pathname: v.string(),
})

app.get("/", () => ({ ok: true, service: "blob" }))

app.get("/api/blob", async (event) => {
  const query = getQuery(event)
  const [error, result] = await blob.list({
    folded: query.folded === "true",
    limit: typeof query.limit === "string" ? Number.parseInt(query.limit, 10) : undefined,
    prefix: typeof query.prefix === "string" ? query.prefix : undefined,
  })
  if (error) throw error
  return result
})

app.put("/api/blob", async (event) => {
  const body = await readValidatedBody(event, blobPutBody)
  const [error, object] = await blob.put(body?.pathname || "notes/hello.txt", body?.value || "hello world", {
    contentType: "text/plain; charset=utf-8",
  })
  if (error) throw error
  return object
})

app.delete("/api/blob", async (event) => {
  const body = await readValidatedBody(event, blobDeleteBody)
  const [error] = await blob.del(body.pathname)
  if (error) throw error
  return { ok: true }
})

app.get("/api/blob/head", async (event) => {
  const pathname = getQuery(event).pathname
  if (typeof pathname !== "string" || pathname.length === 0) {
    throw createError({ statusCode: 400, statusMessage: "Missing pathname" })
  }

  const [error, object] = await blob.head(pathname)
  if (error) throw error
  return object
})

app.get("/api/blob/body", async (event) => {
  const pathname = getQuery(event).pathname
  if (typeof pathname !== "string" || pathname.length === 0) {
    throw createError({ statusCode: 400, statusMessage: "Missing pathname" })
  }

  const [error, file] = await blob.get(pathname)
  if (error) throw error
  return {
    ok: true,
    text: file ? await file.text() : null,
  }
})

app.get("/api/blob/serve", async (event) => {
  const pathname = getQuery(event).pathname
  if (typeof pathname !== "string" || pathname.length === 0) {
    throw createError({ statusCode: 400, statusMessage: "Missing pathname" })
  }

  const [error, stream] = await blob.serve(event, pathname)
  if (error) throw error
  return stream
})

export default app
