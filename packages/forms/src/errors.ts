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
    /** A production build has forms that store submissions, but the app has no Database. */
    FORMS_B0002: {
      ...dynamicError,
      fix: "Enable database in vitehub(), or set store: false with notify or onSubmit in every form that does not need stored submissions.",
    },
    /** A form schema has a field that a surface cannot draw, such as a nested object in a Slack modal. */
    FORMS_FIELD_NOT_DRAWABLE: {
      why: ({ field, found, surface, takes }: { field: string, found: string, surface: string, takes: string }) => `${field ? `The field \`${field}\`` : "The form schema"} is ${found}. ${surface} takes ${takes}.`,
      fix: "Keep the form flat: one field for each text, number, true or false, or choice. Move nested data to its own form, or join it into one text field.",
    },
    /** The store could not read or write submissions. */
    FORMS_R0001: dynamicError,
    /** No submission has that id. */
    FORMS_R0002: dynamicError,
    // Named errors. Keep these codes in alphabetical order.
    FORMS_AUTOFORM_SCHEMA_INVALID: {
      why: "[vitehub] AutoForm needs a Valibot object schema, such as v.object({ message: v.string() }).",
      fix: "Pass AutoForm the Valibot `v.object({ ... })` schema of the form, with one entry for each field.",
    },
    FORMS_DATABASE_MISSING: {
      why: ({ database }: { database?: string }) => `[vitehub] Forms has no Database${database ? ` named ${JSON.stringify(database)}` : ""}.`,
      fix: "Enable `vitehub({ database: true })` and add the Database that the forms name, or set `store: false` in forms that do not need stored submissions.",
    },
    FORMS_NOT_INSTALLED: {
      why: "[vitehub] The app has no forms. Add server/forms/<name>.ts with defineForm().",
      fix: "Add `server/forms/<name>.ts` that default-exports `defineForm({ ... })`, then build or start the app again.",
    },
    FORMS_SUBMISSION_STATUS_INVALID: {
      why: ({ status }: { status: string }) => `[vitehub] A form submission status is open, done, or spam, not ${status}.`,
      fix: "Pass `setStatus()` one of `open`, `done`, or `spam`.",
    },
  },
})
