import { readFile } from "node:fs/promises"
import { createServer } from "node:http"

// Reads the message on each request, so an edit of message.txt shows on the next reload.
createServer(async (request, response) => {
  const message = (await readFile(new URL("message.txt", import.meta.url), "utf8")).trim()
  response.setHeader("content-type", "text/html; charset=utf-8")
  response.end(`<!doctype html><title>Hello</title><h1>${message}</h1>`)
}).listen(3000, () => console.log("Listening on http://localhost:3000"))
