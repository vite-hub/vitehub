import { defineDiagnostics } from "nostics"

export const formsClientDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/forms/diagnostics",
  codes: {
    // Named errors.
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
