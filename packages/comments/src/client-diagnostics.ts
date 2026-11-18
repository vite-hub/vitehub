import { defineDiagnostics, Diagnostic } from "nostics"

// The codes that the browser client raises, so a page with `createCommentsClient()` or `createAnchor()` does not load
// the whole Comments catalog. `commentsErrorDiagnostics` has them too.
export const commentsClientCodes = {
  COMMENTS_R0001: {
    why: ({ target }: { target: string }) => `createAnchor() found nothing to anchor to for ${target}.`,
    fix: "Pass an element, a non-empty selection, or a point that is over an element of the page.",
  },
  COMMENTS_R0013: {
    why: "The comments request did not get an answer from the server.",
    fix: "Check the connection and the app URL, then try again.",
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

/** A failure that the server answered: a diagnostic with its code, why, and fix, and the HTTP status of the answer. */
export function commentsAnswerError(failure: { code: string, details?: Record<string, unknown>, fix?: string, status: number, why: string }): Diagnostic & { details?: Record<string, unknown>, status: number } {
  const { code, details, fix, status, why } = failure
  const docs = code.startsWith("COMMENTS_") ? `https://vitehub.dev/docs/comments/diagnostics/${code.toLowerCase()}` : undefined
  return Object.assign(new Diagnostic({ code, why, ...(fix ? { fix } : {}), ...(docs ? { docs } : {}) }), { status, ...(details ? { details } : {}) })
}

/** `COMMENTS_R0013`: the request got no usable answer. `status` is 0 when it got no answer at all. */
export function commentsUnansweredError(status: number, cause?: unknown): Diagnostic & { status: number } {
  return Object.assign(commentsClientDiagnostics.COMMENTS_R0013(cause === undefined ? {} : { cause }), { status })
}
