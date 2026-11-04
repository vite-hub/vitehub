import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one Choices failure site. Keep published codes stable.
export const decisionsDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: () => "https://vitehub.dev/docs/decisions/limits-and-errors",
  codes: {
    /** A `defineChoices()` definition is invalid. It throws when you define it. */
    DECISIONS_R0001: dynamicError,
    /** The groups or options are over a limit, or an option is invalid. Nothing was asked. */
    DECISIONS_R0002: dynamicError,
    /** The text is empty or longer than `limits.text`. Nothing was asked. */
    DECISIONS_R0003: dynamicError,
    /** The model says the options cannot express the text. The `supported` check is below its threshold. */
    DECISIONS_R0004: dynamicError,
    /** The gateway request failed. The cause has the gateway error. */
    DECISIONS_R0005: dynamicError,
    /** The model answer misses a question that was asked. */
    DECISIONS_R0006: dynamicError,
  },
})
