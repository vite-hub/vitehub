// The Console page loads this module. Without a Console Auth client it has no code, but it keeps a body: the
// Nitro 3 RC development server (env-runner 0.3) never finishes a response with an empty body.
const body = "// No Console Auth client is configured.\n"

export default function consoleClientHandler(): Response {
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/javascript; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  })
}
