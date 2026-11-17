import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
export const browserErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/browser/diagnostics",
  codes: {
    BROWSER_R0001: { ...dynamicError, fix: "Pass a non-empty `audience` string to `session.handoff()` and to `claim()`, and use the same value on both sides." },
    BROWSER_R0002: { ...dynamicError, fix: "Pass `mode: \"live\"` to `session.handoff()`, for example `session.handoff({ mode: \"live\", audience: \"worker\" })`." },
    BROWSER_R0003: { ...dynamicError, fix: "Set `ttl` of `session.handoff()` or `policy.handoffTtl` to a number of milliseconds from 1 to 2147483647, or remove it to use 60000." },
    BROWSER_R0004: { ...dynamicError, fix: "Pass a driver to `createBrowser()`, for example `createBrowser({ driver: localBrowser({ executablePath: \"/usr/bin/chromium\" }) })`." },
    BROWSER_R0005: { ...dynamicError, fix: "Check that the host can open a TCP port on `127.0.0.1` for the local Chromium, then open the session again." },
    BROWSER_R0006: { ...dynamicError, fix: "Run the `executablePath` binary by hand to see why Chromium stops. Check that the host has the libraries that Chromium needs, or raise `startupTimeout` of `localBrowser()`." },
    BROWSER_R0007: { ...dynamicError, fix: "Pass the path of an installed Chromium to `localBrowser({ executablePath })`, for example `\"/usr/bin/chromium\"`." },
    BROWSER_R0008: { ...dynamicError, fix: "Set `startupTimeout` of `localBrowser()` to a number of milliseconds from 1 to 2147483647, or remove it to use 15000." },
    BROWSER_R0009: { ...dynamicError, fix: "Default-export `defineBrowser()` from the Browser Definition file that the message names, in `server/browsers/` or a `*.browser.ts` file." },
    BROWSER_R0010: { ...dynamicError, fix: "Pass a handler function to `defineBrowser()`, for example `defineBrowser(async (input, { browser }) => ...)`." },
    BROWSER_R0011: { ...dynamicError, fix: "In Workers, connect through a Cloudflare Browser binding. Run CDP providers, such as `localBrowser()`, on a Node.js host." },
    BROWSER_B0001: { ...dynamicError, fix: "Set `browser: { binding }` in `vitehub()` to letters, digits, and `_` that do not start with a digit, such as `\"BROWSER\"`, or remove `binding`." },
    BROWSER_B0002: { ...dynamicError, fix: "Set `browser: { engine }` in `vitehub()` to `\"kitesurf\"` or `\"chromium\"`, or remove `engine` to use Kitesurf." },
    // Named errors. Keep these codes in alphabetical order.
    BROWSER_CONTENT_FAILED: {
      why: ({ status }: { status: number }) => `Browser content request failed with status ${status}`,
      fix: "Call `runBrowserAction(\"content\", input)` to read the `error.code` and `error.message` of the failed request, then fix the Browser binding or the input that they name.",
    },
  },
})
