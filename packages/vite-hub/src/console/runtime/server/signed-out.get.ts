import type { ConsoleRequestEvent } from "./request.ts"

function signInPath(event: ConsoleRequestEvent): string {
  const requestURL = event.req?.url ?? event.node?.req?.url ?? "/_vitehub/signed-out"
  const pathname = new URL(String(requestURL), "http://localhost").pathname
  return pathname.endsWith("/_vitehub/signed-out")
    ? pathname.slice(0, -"/signed-out".length)
    : "/_vitehub"
}

export default function consoleSignedOutHandler(event: ConsoleRequestEvent): Response {
  const signIn = signInPath(event)
  const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="robots" content="noindex, nofollow">
    <title>Signed out · ViteHub Console</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { min-height: 100dvh; margin: 0; display: grid; place-items: center; background: light-dark(#fafafa, #0a0a0a); color: light-dark(#171717, #f5f5f5); }
      main { width: min(24rem, calc(100% - 3rem)); }
      h1 { margin: 0 0 .5rem; font-size: 1.5rem; font-weight: 600; }
      p { margin: 0 0 1.5rem; color: light-dark(#525252, #a3a3a3); line-height: 1.5; }
      a { display: inline-flex; align-items: center; min-height: 2.5rem; padding: 0 1rem; border-radius: .5rem; background: light-dark(#171717, #f5f5f5); color: light-dark(#fff, #171717); text-decoration: none; font-weight: 500; }
      a:focus-visible { outline: 2px solid #3b82f6; outline-offset: 3px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Signed out</h1>
      <p>Your ViteHub Console session has ended.</p>
      <a href="${signIn}">Sign in again</a>
    </main>
  </body>
</html>`
  return new Response(page, {
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "x-robots-tag": "noindex, nofollow",
    },
  })
}
