import { consoleMountBase } from "../console-route.ts"
import { consoleSignInPage, consoleSignInRedirect } from "./access.ts"
import { assertConsoleRequest, consoleRequestURL } from "./request.ts";

import type { ConsoleRequestEvent } from "./request.ts";

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="theme-color" data-vitehub-console-theme="light" content="#fdfdfd" media="(prefers-color-scheme: light)">
    <meta name="theme-color" data-vitehub-console-theme="dark" content="#0a0a0a" media="(prefers-color-scheme: dark)">
    <meta name="description" content="Read-only ViteHub project inspection">
    <meta name="robots" content="noindex, nofollow">
    <title>ViteHub Console</title>
    <link rel="stylesheet" href="/_vitehub/assets/__VITEHUB_CONSOLE_STYLE_ASSET__">
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/api/_vitehub/console/client.js"></script>
    <script type="module" src="/_vitehub/assets/__VITEHUB_CONSOLE_SCRIPT_ASSET__"></script>
  </body>
</html>`;

const escapeAttribute = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

export default async function consolePageHandler(event: ConsoleRequestEvent): Promise<Response> {
  assertConsoleRequest(event);
  // With a sign-in page, a signed-out visit goes there and comes back, as with Console Auth.
  const signIn = await consoleSignInRedirect(event)
  if (signIn) return signIn
  const { pathname } = consoleRequestURL(event)
  const mountBase = consoleMountBase(pathname)
  // The Console links to the sign-in page when a session ends while the page is open.
  const signInPage = consoleSignInPage(pathname)
  const signInMeta = signInPage ? `\n    <meta name="vitehub-console-sign-in" content="${escapeAttribute(signInPage)}">` : ""
  const mountedPage = page
    .replace('<meta name="robots" content="noindex, nofollow">', robots => `${robots}${signInMeta}`)
    .replaceAll('href="/_vitehub/assets/', `href="${mountBase}/_vitehub/assets/`)
    .replaceAll('src="/api/_vitehub/console/client.js"', `src="${mountBase}/api/_vitehub/console/client.js"`)
    .replaceAll('src="/_vitehub/assets/', `src="${mountBase}/_vitehub/assets/`)
  return new Response(mountedPage, {
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
