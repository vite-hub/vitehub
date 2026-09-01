import { assertConsoleRequest } from "./request.ts";

import type { ConsoleRequestEvent } from "./request.ts";

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="theme-color" content="#fdfdfd" media="(prefers-color-scheme: light)">
    <meta name="theme-color" content="#0a0a0a" media="(prefers-color-scheme: dark)">
    <meta name="description" content="Read-only ViteHub project inspection">
    <meta name="robots" content="noindex, nofollow">
    <title>ViteHub Console</title>
    <link rel="stylesheet" href="/_vitehub/assets/__VITEHUB_CONSOLE_STYLE_ASSET__">
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/_vitehub/assets/__VITEHUB_CONSOLE_SCRIPT_ASSET__"></script>
  </body>
</html>`;

export default function consolePageHandler(event: ConsoleRequestEvent): Response {
  assertConsoleRequest(event);
  return new Response(page, {
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
