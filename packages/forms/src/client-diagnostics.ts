import { defineDiagnostics } from "nostics"

// The codes of a failed submission. The browser client loads only this catalog, not the whole Forms catalog.
export const formsClientDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/forms/diagnostics",
  codes: {
    // Named errors. Keep these codes in alphabetical order.
    FORMS_SUBMIT_FAILED: {
      why: ({ reason }: { reason: string }) => reason,
      fix: "Read `error.status`: 0 means the request got no answer, so check the connection and the app URL, 429 means wait and send again, and a 5xx status is in the server log.",
    },
    FORMS_SUBMIT_INVALID: {
      why: ({ reason }: { reason: string }) => reason,
      fix: "Show `fieldErrors(error)` next to each field, and send the form again after the person corrects the values.",
    },
  },
})
