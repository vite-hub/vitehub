/**
 * The page where the sign-in of an MCP client lands. Better Auth's OAuth provider sends both its login step and its
 * consent step to `/oauth` with a signed query. Signed out, the person signs in with GitHub or a passkey, and the
 * provider resumes the authorization. Signed in, the person sees the account, where the answer goes, and allows or
 * denies the client.
 */

import { oauthPageScript as script } from "./oauth-page.injected.ts"

const styles = `
:root { color-scheme: light dark; --text: #171717; --muted: #666; --line: #e5e5e5; --surface: #fff; --page: #fafafa; --accent: #171717; --accent-text: #fff; }
@media (prefers-color-scheme: dark) { :root { --text: #ededed; --muted: #a1a1a1; --line: #2e2e2e; --surface: #111; --page: #0a0a0a; --accent: #ededed; --accent-text: #0a0a0a; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--page); color: var(--text); font: 15px/1.5 Geist, ui-sans-serif, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
main { width: 100%; max-width: 400px; display: grid; gap: 16px; }
svg { width: 22px; height: 20px; }
h1 { margin: 0; font-size: 20px; line-height: 28px; font-weight: 600; text-wrap: balance; }
p { margin: 0; color: var(--muted); }
code { font: 0.9em ui-monospace, monospace; color: var(--text); }
.panel { display: flex; align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.who { display: grid; flex: 1; min-width: 0; }
#email { color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; }
.actions { display: grid; gap: 8px; }
button { height: 40px; padding: 0 16px; border: 1px solid var(--accent); border-radius: 6px; background: var(--accent); color: var(--accent-text); font: inherit; font-weight: 500; cursor: pointer; }
button.secondary { background: transparent; color: var(--text); border-color: var(--line); }
button.link { height: auto; padding: 0; border: 0; background: none; color: var(--text); text-decoration: underline; text-underline-offset: 0.2em; }
button:disabled { opacity: 0.6; cursor: default; }
button:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
.note { font-size: 13px; }
[role=alert] { color: #e5484d; font-size: 13px; }
a { color: var(--text); text-underline-offset: 0.2em; }
[hidden] { display: none !important; }
`

/** The `/oauth` page. Its script runs with a nonce, and it sends requests only to the Console origin. */
export function renderOAuthPage(): Response {
  const nonce = crypto.randomUUID()
  const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="robots" content="noindex, nofollow">
    <title>Connect an agent · ViteHub Console</title>
    <style>${styles}</style>
  </head>
  <body>
    <main>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 18" aria-hidden="true"><path fill="currentColor" d="M19.734 8.156 15.576.844A1.66 1.66 0 0 0 14.135 0H5.819C5.226 0 4.677.32 4.38.844L.222 8.156a1.71 1.71 0 0 0 0 1.688l4.158 7.312c.297.523.846.844 1.439.844h8.316c.593 0 1.142-.32 1.438-.844l4.158-7.312c.3-.523.3-1.165.003-1.688Z"/></svg>
      <h1>Connect an agent</h1>
      <p id="text">One moment.</p>
      <div id="account" class="panel" hidden>
        <span class="who"><span id="name"></span><span id="email"></span></span>
        <button id="switch" type="button" class="link">Switch account</button>
      </div>
      <p id="redirect" class="note" hidden></p>
      <div id="buttons" class="actions"></div>
      <p id="new" class="note" hidden>New to ViteHub? <a href="/" target="_blank" rel="noopener">Create an account</a>, then sign in here.</p>
      <p role="alert" hidden></p>
    </main>
    <script nonce="${nonce}">${script}</script>
  </body>
</html>`
  return new Response(page, {
    headers: {
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "x-robots-tag": "noindex, nofollow",
    },
  })
}
