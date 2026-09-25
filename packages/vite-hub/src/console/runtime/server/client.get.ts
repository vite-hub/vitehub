export default function consoleClientHandler(): Response {
  return new Response("", {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/javascript; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  })
}
