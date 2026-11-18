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
    // Named errors. Keep these codes in alphabetical order.
    UI_CLIPBOARD_UNAVAILABLE: {
      why: "The clipboard is not available.",
      fix: "Serve the page over HTTPS or from `localhost`, where the browser gives pages the clipboard API.",
    },
    UI_MARKDOWN_UPLOAD_URL_MISSING: {
      why: ({ route, file }: { route: string, file: string }) => `${route} stored ${file} without a URL. Serve the Blob store with \`blob.serve\` so the editor can link it.`,
      fix: "Add `serve` to the Blob options, such as `vitehub({ blob: { serve: { access: 'public' } } })`, so the upload route returns a URL for each file that it stores.",
    },
    UI_RELATIVE_TIME_NOW_INVALID: {
      why: "RelativeTime cannot read the supplied clock value.",
      fix: "Pass a valid Date, an ISO date string, or milliseconds as now.",
    },
    UI_RELATIVE_TIME_THRESHOLD_INVALID: {
      why: ({ threshold }: { threshold: string }) => `RelativeTime threshold "${threshold}" is not a duration.`,
      fix: 'Pass a number and a unit, such as "3w", or "none" as threshold.',
    },
    UI_ZIP_PATH_UNSAFE: {
      why: "ZIP files must use safe project-relative paths.",
      fix: "Pass `zipFiles()` and `downloadZip()` a folder name and file paths that are relative to the project, without empty, `.`, or `..` segments, `:`, or a backslash.",
    },
  },
})
