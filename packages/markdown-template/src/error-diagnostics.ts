import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
export const markdownTemplateErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: () => "https://vitehub.dev/docs/reference/errors-diagnostics",
  codes: {
    MARKDOWN_TEMPLATE_R0001: dynamicError,
    MARKDOWN_TEMPLATE_R0002: dynamicError,
    MARKDOWN_TEMPLATE_R0003: dynamicError,
    MARKDOWN_TEMPLATE_R0004: dynamicError,
    MARKDOWN_TEMPLATE_R0005: dynamicError,
    MARKDOWN_TEMPLATE_R0006: dynamicError,
    MARKDOWN_TEMPLATE_R0007: dynamicError,
    MARKDOWN_TEMPLATE_R0008: dynamicError,
    MARKDOWN_TEMPLATE_R0009: dynamicError,
    MARKDOWN_TEMPLATE_R0010: dynamicError,
    MARKDOWN_TEMPLATE_B0001: dynamicError,
    MARKDOWN_TEMPLATE_B0002: dynamicError,
    MARKDOWN_TEMPLATE_B0003: dynamicError,
    MARKDOWN_TEMPLATE_R0011: dynamicError,
    MARKDOWN_TEMPLATE_R0012: dynamicError,
    MARKDOWN_TEMPLATE_R0013: dynamicError,
    MARKDOWN_TEMPLATE_R0014: dynamicError,
    MARKDOWN_TEMPLATE_R0015: dynamicError,
    MARKDOWN_TEMPLATE_R0016: dynamicError,
    MARKDOWN_TEMPLATE_R0017: dynamicError,
    MARKDOWN_TEMPLATE_R0018: dynamicError,
    MARKDOWN_TEMPLATE_R0019: dynamicError,
    MARKDOWN_TEMPLATE_R0020: dynamicError,
    MARKDOWN_TEMPLATE_R0021: dynamicError,
    MARKDOWN_TEMPLATE_R0022: dynamicError,
    MARKDOWN_TEMPLATE_R0023: dynamicError,
    MARKDOWN_TEMPLATE_R0024: dynamicError,
    MARKDOWN_TEMPLATE_R0025: dynamicError,
    MARKDOWN_TEMPLATE_R0026: dynamicError,
    MARKDOWN_TEMPLATE_R0027: dynamicError,
    MARKDOWN_TEMPLATE_R0028: dynamicError,
    MARKDOWN_TEMPLATE_R0029: dynamicError,
    MARKDOWN_TEMPLATE_R0030: dynamicError,
    MARKDOWN_TEMPLATE_R0031: dynamicError,
  },
})
