import { consoleDocumentMetadata } from "../../document-metadata.ts"
import { consoleMountBase } from "../console-route.ts"
import { consoleDiagnosticBody, consoleStatusDiagnosticCode, isConsoleDiagnosticCode } from "../diagnostics.ts"
import { consoleAllowsRequest, consoleAppAuthBasePath, consolePageRejection, consoleSignInPage, consoleSignInRedirect } from "./access.ts"
import { assertConsoleRequest, consoleRequestURL } from "./request.ts";
import { isConsoleDevelopmentBuild } from "./development.ts"

import type { ConsoleRequestEvent } from "./request.ts";

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, interactive-widget=resizes-content">
    <meta name="theme-color" data-vitehub-console-theme="light" content="#fdfdfd" media="(prefers-color-scheme: light)">
    <meta name="theme-color" data-vitehub-console-theme="dark" content="#0a0a0a" media="(prefers-color-scheme: dark)">
    <meta name="robots" content="noindex, nofollow">${consoleDocumentMetadata}
    <title>ViteHub Console</title>
    <link rel="stylesheet" href="/_vitehub/assets/__VITEHUB_CONSOLE_STYLE_ASSET__">
  </head>
  <body>
    <div id="app"><p role="status" style="padding:2rem;font:14px/1.5 system-ui">Opening Console…</p><noscript>Enable JavaScript to use the Console.</noscript></div>
    <script type="module" src="/api/_vitehub/console/client.js"></script>
    <script type="module" src="/_vitehub/assets/__VITEHUB_CONSOLE_SCRIPT_ASSET__"></script>
  </body>
</html>`;

const escapeAttribute = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

/** The page for a rejection of the access check: `Access denied` for `403`, with the why and the fix of its Console code. */
async function rejectedPage(rejection: Response): Promise<Response> {
  const body: unknown = await rejection.clone().json().catch(() => undefined)
  const code: unknown = body instanceof Object ? Reflect.get(body, "code") : undefined
  const message: unknown = body instanceof Object ? Reflect.get(body, "message") : undefined
  const diagnostic = isConsoleDiagnosticCode(code)
    ? consoleDiagnosticBody(code, typeof message === "string" ? message : undefined)
    : consoleDiagnosticBody(consoleStatusDiagnosticCode(rejection.status))
  const development = isConsoleDevelopmentBuild()
  const title = rejection.status === 403 ? "Access denied" : "The Console cannot open"
  const document = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="robots" content="noindex, nofollow">${consoleDocumentMetadata}
    <title>${title} · ViteHub Console</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { min-height: 100dvh; margin: 0; display: grid; place-items: center; background: light-dark(#fafafa, #0a0a0a); color: light-dark(#171717, #f5f5f5); }
      main { width: min(24rem, calc(100% - 3rem)); }
      h1 { margin: 0 0 .5rem; font-size: 1.5rem; font-weight: 600; }
      p { color: light-dark(#525252, #a3a3a3); line-height: 1.5; overflow-wrap: anywhere; }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>${escapeAttribute(diagnostic.message)}</p>
      <p>${escapeAttribute(diagnostic.fix ?? "")}</p>
    </main>
  </body>
</html>`
  return new Response(document, {
    headers: {
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors ${development ? "'self'" : "'none'"}`,
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": development ? "SAMEORIGIN" : "DENY",
      "x-robots-tag": "noindex, nofollow",
    },
    status: rejection.status,
  })
}

export default async function consolePageHandler(event: ConsoleRequestEvent): Promise<Response> {
  assertConsoleRequest(event);
  // With a sign-in page, a signed-out visit goes there and comes back, as with Console Auth.
  const signIn = await consoleSignInRedirect(event)
  if (signIn) return signIn
  // A visitor that the data routes reject does not get the Console. A signed-out visitor gets its signed-out state.
  const rejection = await consolePageRejection(event)
  if (rejection) return rejection.app ? rejection.response : await rejectedPage(rejection.response)
  const { pathname } = consoleRequestURL(event)
  const mountBase = consoleMountBase(pathname)
  // The Console links to the sign-in page when a session ends while the page is open.
  const signInPage = consoleSignInPage(pathname)
  const authBase = await consoleAppAuthBasePath(event)
  const authMeta = authBase ? `\n    <meta name="vitehub-console-auth-base" content="${escapeAttribute(authBase)}">` : ""
  const signInMeta = signInPage ? `\n    <meta name="vitehub-console-sign-in" content="${escapeAttribute(signInPage)}">` : ""
  const mountedPage = page
    .replace('<meta name="robots" content="noindex, nofollow">', robots => `${robots}${signInMeta}${authMeta}`)
    .replaceAll('href="/_vitehub/assets/', `href="${mountBase}/_vitehub/assets/`)
    .replaceAll('src="/api/_vitehub/console/client.js"', `src="${mountBase}/api/_vitehub/console/client.js"`)
    .replaceAll('src="/_vitehub/assets/', `src="${mountBase}/_vitehub/assets/`)
  // On a development server, Nuxt DevTools and Vite DevTools show the Console in a frame of the same origin. The
  // document editor shows pages of this origin in a frame, and its draft view posts a form to them.
  const development = isConsoleDevelopmentBuild()
  const embedded = consoleRequestURL(event).searchParams.get("embed") === "1" && await consoleAllowsRequest(event)
  const mayFrame = development || embedded
  return new Response(mountedPage, {
    headers: {
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; frame-src 'self'; frame-ancestors ${mayFrame ? "'self'" : "'none'"}; base-uri 'none'; form-action 'self'`,
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": mayFrame ? "SAMEORIGIN" : "DENY",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
