import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

export const choicesDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/choices/diagnostics",
  codes: {
    DECISIONS_R0001: { ...dynamicError, fix: "Change the `defineChoices()` option that the message names: one of `gateway` with `ask()` or `model`, at least one group, a label on each group, and thresholds from 0 to 1." },
    DECISIONS_R0002: { ...dynamicError, fix: "Use fewer options, a list of option objects with a label and a unique text or finite number value, aliases as a list of text, and an `options` function that does not throw. `error.cause` holds the error of a failed `options` function." },
    DECISIONS_R0003: { ...dynamicError, fix: "Pass `resolve()` a nonempty text no longer than `limits.text`." },
    DECISIONS_R0004: { ...dynamicError, fix: "Show a message and let the person use your normal controls, or ask with a text that the options can express." },
    DECISIONS_R0005: {
      why: ({ reason }: { reason?: string, fix?: string }) => reason ? `[vitehub] The gateway request failed: ${reason}` : "[vitehub] The gateway request failed.",
      fix: ({ fix }: { reason?: string, fix?: string }) => fix ?? "Read error.cause for the gateway error.",
    },
    DECISIONS_R0006: { ...dynamicError, fix: "Call `resolve()` again, because the model left a question without an answer. A retry often helps." },
    // Named errors.
    DECISIONS_CLI_ARGUMENTS_INVALID: {
      why: ({ problem }: { problem: string }) => problem,
      fix: "Run `vitehub choices run <file> <text>`, pass `--context` as a JSON object, and pass `--export <name>` when the file has several `defineChoices()` exports.",
    },
    DECISIONS_CLI_CHOICES_NOT_FOUND: {
      why: ({ problem }: { problem: string }) => problem,
      fix: "Run `vitehub choices list` to find the files and exports that call `defineChoices()`, and pass one of them to `vitehub choices run`.",
    },
    DECISIONS_TESTING_SELECTION_INVALID: {
      why: ({ problem }: { problem: string }) => `[vitehub] ${problem}`,
      fix: "Pass `selectionGateway()` as the `gateway` of `defineChoices()`. Name only its groups: an option value or `null` for a group with `multiple: false`, and `{ include, exclude }` with option values for the other groups.",
    },
  },
})
