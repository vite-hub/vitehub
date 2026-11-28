import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

export const browserErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/browser/diagnostics",
  codes: {
    BROWSER_R0001: { ...dynamicError, fix: "Pass a non-empty `audience` string to `session.handoff()` and to `claim()`, and use the same value on both sides." },
    BROWSER_R0002: { ...dynamicError, fix: "Pass `mode: \"live\"` to `session.handoff()`, for example `session.handoff({ mode: \"live\", audience: \"worker\" })`." },
    BROWSER_R0003: { ...dynamicError, fix: "Set `ttl` of `session.handoff()` or `policy.handoffTtl` to a number of milliseconds from 1 to 2147483647, or remove it to use 60000." },
    BROWSER_R0004: { ...dynamicError, fix: "Pass a driver to `createBrowser()`, for example `createBrowser({ driver: localBrowser({ executablePath: \"/usr/bin/chromium\" }) })`." },
    BROWSER_R0005: { ...dynamicError, fix: "Check that the host can open a TCP port on `127.0.0.1` for the local Chromium, then open the session again." },
    BROWSER_R0006: { ...dynamicError, fix: "Run the `executablePath` binary by hand to see why Chromium stops. Check that the host has the libraries that Chromium needs, or raise `startupTimeout` of `localBrowser()`." },
    BROWSER_R0007: { ...dynamicError, fix: "Pass the path of an installed Chromium to `localBrowser({ executablePath })`, for example `\"/usr/bin/chromium\"`, or remove `executablePath` to find one." },
    BROWSER_R0008: { ...dynamicError, fix: "Set `startupTimeout` of `localBrowser()` to a number of milliseconds from 1 to 2147483647, or remove it to use 15000." },
    BROWSER_R0009: { ...dynamicError, fix: "Default-export `defineBrowser()` from the Browser Definition file that the message names, in `server/browsers/` or a `*.browser.ts` file." },
    BROWSER_R0010: { ...dynamicError, fix: "Pass a handler function to `defineBrowser()`, for example `defineBrowser(async (input, { browser }) => ...)`." },
    BROWSER_R0011: { ...dynamicError, fix: "In Workers, connect through a Cloudflare Browser binding. Run CDP providers, such as `localBrowser()`, on a Node.js host." },
    BROWSER_B0001: { ...dynamicError, fix: "Set `browser: { binding }` in `vitehub()` to letters, digits, and `_` that do not start with a digit, such as `\"BROWSER\"`, or remove `binding`." },
    BROWSER_B0002: { ...dynamicError, fix: "Set `browser: { engine }` in `vitehub()` to `\"kitesurf\"` or `\"chromium\"`, or remove `engine` to use Kitesurf." },
    // Named errors.
    BROWSER_CDP_URL_INVALID: {
      why: "The CDP URL of the remote Chromium must use the `ws`, `wss`, `http`, or `https` protocol.",
      fix: "Set `BROWSER_CDP_URL` or the `url` option of `cdpBrowser()` to a browser WebSocket or a DevTools HTTP endpoint.",
    },
    BROWSER_CDP_URL_REQUIRED: {
      why: "The Browser driver needs a remote Chromium, but `BROWSER_CDP_URL` is not set.",
      fix: "Set `BROWSER_CDP_URL` to a DevTools HTTP endpoint or a browser WebSocket, such as a Browserless or Browserbase URL.",
    },
    BROWSER_CHROMIUM_NOT_FOUND: {
      ...dynamicError,
      fix: "Install Chromium on the host, set `BROWSER_EXECUTABLE_PATH` to the Chromium binary, or set `BROWSER_CDP_URL` to a remote Chromium.",
    },
    BROWSER_CHROMIUM_SANDBOX_UNAVAILABLE: {
      why: "Chromium found no usable sandbox on this host, so it cannot start with its process isolation on.",
      fix: "Allow unprivileged user namespaces for Chromium. On a trusted host, you can instead set `BROWSER_SANDBOX=false` or `localBrowser({ sandbox: false })`.",
    },
    BROWSER_QUICK_ACTION_REQUIRES_BROWSER_RUN: {
      ...dynamicError,
      fix: "Use `runBrowserContent()` with a URL, or open a session with `browser.open()`. Other quick actions need Cloudflare Browser Run.",
    },
    BROWSER_RENAMED_PROVIDER_KEY: {
      why: "`createBrowser()` got a `provider` option. ViteHub renamed this option to `driver`, and it does not read `provider`.",
      fix: "Pass the driver as `createBrowser({ driver: localBrowser() })`, or run `npx @vite-hub/codemods driver-key` to rename it in every file.",
    },
  },
})
