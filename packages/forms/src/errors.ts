import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one Forms failure site. Keep published codes stable.
export const formsDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/forms/limits-and-errors",
  codes: {
    /** A `defineForm()` definition is invalid. It throws when you define it. */
    FORMS_D0001: dynamicError,
    /** The store could not read or write submissions. */
    FORMS_R0001: dynamicError,
    /** No submission has that id. */
    FORMS_R0002: dynamicError,
    /** The form has a notification that the app cannot send, for example `notify.email` without Email. */
    FORMS_R0003: dynamicError,
  },
})
