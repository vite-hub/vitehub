import { defineDiagnostics } from "nostics"

// The codes that the browser entry raises. Its own catalog keeps the page bundle small.
export const webContainerBrowserDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/web-container/diagnostics",
  codes: {
    // Named errors. Keep these codes in alphabetical order.
    WEB_CONTAINER_UNSUPPORTED: {
      why: ({ reason }: { reason: string }) => reason,
      fix: "Call `bootWebContainer()` in a browser page that is cross-origin isolated: list the page in the `routes` option of `hubWebContainer` in `vitehub()`, or send the isolation headers on its route in production.",
    },
  },
})
