import { managementErrorBody } from "./http-diagnostics.ts";

/** The cookie that keeps the Console page to return to while the provider flow runs. */
export const RETURN_COOKIE = "vitehub_connection_return";
/** Seconds that a success page waits before it returns to the Console. */
export const RETURN_DELAY_SECONDS = 2;

const MAX_RETURN_LENGTH = 2048;

/**
 * A same-origin path to return to after the provider flow, or `undefined`. Only a path such as
 * `/_vitehub/connections` passes, so a crafted link cannot send the browser to another site.
 */
export function returnPath(value: string | null | undefined, origin: string): string | undefined {
  if (!value || value.length > MAX_RETURN_LENGTH || !value.startsWith("/") || value.startsWith("//") || value.includes("\\"))
    return undefined;
  try {
    const url = new URL(value, origin);
    return url.origin === origin ? `${url.pathname}${url.search}` : undefined;
  } catch {
    return undefined;
  }
}

export function readCookie(request: Request, key: string): string | undefined {
  for (const part of request.headers.get("cookie")?.split(";") ?? []) {
    const [cookieName, ...value] = part.trim().split("=");
    if (cookieName === key) return value.join("=");
  }
  return undefined;
}

/** The Console page that started this flow: the `return` query of the connect route, or the return cookie. */
export function requestReturnPath(request: Request): string | undefined {
  const url = new URL(request.url);
  const query = url.searchParams.get("return");
  if (query !== null) return returnPath(query, url.origin);
  const cookie = readCookie(request, RETURN_COOKIE);
  if (!cookie) return undefined;
  try {
    return returnPath(decodeURIComponent(cookie), url.origin);
  } catch {
    return undefined;
  }
}

export interface ConnectionsPageInput {
  /** A Connections error code. The page shows it with the fix and docs link from the catalog. */
  readonly code?: string;
  readonly message: string;
  readonly outcome: "error" | "success";
  /** The Console page to return to. A success page returns there by itself. */
  readonly returnTo?: string;
  readonly status: number;
  readonly title: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

const icons = {
  error:
    '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.25"/><path d="M10 6v4.5M10 13.5v.01"/></svg>',
  success:
    '<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.25"/><path d="m6.75 10.25 2.25 2.25 4.25-4.5"/></svg>',
} as const;

// The Console palette in light and dark mode. The page loads no external assets.
const style = `:root{color-scheme:light dark;--bg:#fdfdfd;--text:#27272a;--muted:#71717a;--strong:#18181b;--ok:#16a34a;--error:#dc2626;--ring:#a1a1aa;--button:#18181b;--button-text:#fafafa}
@media (prefers-color-scheme:dark){:root{--bg:#0a0a0a;--text:#f4f4f5;--muted:#a1a1aa;--strong:#fafafa;--ok:#4ade80;--error:#f87171;--ring:#71717a;--button:#fafafa;--button-text:#0a0a0a}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:13px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:26rem;padding:32px 24px}
.icon{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.success .icon{color:var(--ok)}.error .icon{color:var(--error)}
h1{margin:12px 0 4px;font-size:14px;font-weight:500;color:var(--strong)}
p{margin:0;color:var(--muted)}
.fix{margin-top:6px;color:var(--text)}
nav{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;margin-top:20px}
a{color:var(--muted);text-underline-offset:3px}
a:hover{color:var(--strong)}
a:focus-visible{outline:2px solid var(--ring);outline-offset:2px;border-radius:6px}
.button{display:inline-flex;align-items:center;min-height:32px;padding:0 12px;border-radius:6px;background:var(--button);color:var(--button-text);font-weight:500;text-decoration:none}
.button:hover{color:var(--button-text);opacity:.9}
code{font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}
.code{margin-top:16px}`;

/**
 * The HTML page of the connect and callback routes. It is the last page of the provider flow, so it says
 * what happened, how to fix a failure, and how to get back to the Console.
 */
export function page(input: ConnectionsPageInput): Response {
  const diagnostic = input.code ? managementErrorBody(input.code, input.message) : undefined;
  const back = input.returnTo ? escapeHtml(input.returnTo) : undefined;
  const autoReturn = input.outcome === "success" && back;
  const links = [
    back ? `<a class="button" href="${back}">Back to Connections</a>` : "",
    diagnostic?.docs ? `<a href="${escapeHtml(diagnostic.docs)}" target="_blank" rel="noreferrer">Read the docs</a>` : "",
  ].join("");
  const hint = autoReturn
    ? `<p class="fix">Returning to Connections…</p>`
    : !back && input.outcome === "success"
      ? `<p class="fix">You can close this tab.</p>`
      : "";
  const body = [
    `<main class="${input.outcome}" role="${input.outcome === "error" ? "alert" : "status"}">`,
    icons[input.outcome],
    `<h1>${escapeHtml(input.title)}</h1>`,
    `<p>${escapeHtml(input.message)}</p>`,
    diagnostic?.fix ? `<p class="fix">${escapeHtml(diagnostic.fix)}</p>` : "",
    hint,
    links ? `<nav>${links}</nav>` : "",
    diagnostic ? `<p class="code"><code>${escapeHtml(diagnostic.code)} · ${input.status}</code></p>` : "",
    "</main>",
  ].join("");
  return new Response(
    [
      '<!doctype html><html lang="en"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex,nofollow">',
      autoReturn ? `<meta http-equiv="refresh" content="${RETURN_DELAY_SECONDS};url=${back}">` : "",
      `<title>${escapeHtml(input.title)} · ViteHub</title><style>${style}</style></head>`,
      `<body>${body}</body></html>`,
    ].join(""),
    {
      headers: {
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": "no-referrer",
      },
      status: input.status,
    },
  );
}
