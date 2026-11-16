import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
// Retired codes. Do not reuse them: UI_R0003.
export const uiErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/ui/diagnostics",
  codes: {
    UI_R0001: { ...dynamicError, fix: "Pick the file again. The browser could not read the file that the message names." },
    UI_R0002: { ...dynamicError, fix: "Use the component that the message names as it says: inside its parent, such as `CommentLayer`, `ChoicesInput`, or `MessageScroller`, or with the props that the message names." },
  },
})
