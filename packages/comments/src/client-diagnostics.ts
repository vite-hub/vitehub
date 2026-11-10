import { defineDiagnostics } from "nostics"

// The codes that the browser client raises, so a page with `createCommentsClient()` or `createAnchor()` does not load
// the whole Comments catalog. `commentsErrorDiagnostics` has them too.
export const commentsClientCodes = {
  COMMENTS_R0001: {
    why: ({ target }: { target: string }) => `createAnchor() found nothing to anchor to for ${target}.`,
    fix: "Pass an element, a non-empty selection, or a point that is over an element of the page.",
  },
  COMMENTS_R0015: {
    why: "The comment list kept changing while its pages were loading.",
    fix: "Refresh again. The previous cache is kept until two complete scans agree.",
  },
}

export const commentsClientDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/comments/diagnostics",
  codes: commentsClientCodes,
})
