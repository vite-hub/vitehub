import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one Forms failure site. Keep published codes stable.
export const formsDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/forms/diagnostics",
  codes: {
    /** A `defineForm()` definition is invalid. It throws when you define it. */
    FORMS_C0001: dynamicError,
    /** A file of `server/forms/` has a name that is not a route segment, or two files define the same form. */
    FORMS_B0001: dynamicError,
    /** The store could not read or write submissions. */
    FORMS_R0001: dynamicError,
    /** No submission has that id. */
    FORMS_R0002: dynamicError,
  },
})
