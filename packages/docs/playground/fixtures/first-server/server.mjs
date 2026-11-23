import { createServer } from "node:http"

// Loads a module of the lesson again on each request, so an edit shows on the next request.
async function load(file) {
  try {
    return (await import(`./${file}?t=${Date.now()}`)).default
  }
  catch {
    return undefined
  }
}

createServer(async (request, response) => {
  const greeting = await load("greeting.mjs")
  const clock = await load("clock.mjs")
  const lines = [greeting ? greeting() : "Create greeting.mjs to change this answer."]
  if (clock) lines.push(clock())
  response.setHeader("content-type", "text/plain; charset=utf-8")
  response.end(`${lines.join("\n")}\n`)
}).listen(3000, () => console.log("Listening on http://localhost:3000"))
