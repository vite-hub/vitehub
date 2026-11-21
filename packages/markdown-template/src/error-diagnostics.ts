import { defineDiagnostics } from "nostics"

const dynamicError = {
  why: ({ message }: { message?: unknown }) => message === undefined ? "" : String(message),
}

// Each code identifies one ViteHub failure site. Keep published codes stable.
// Retired codes. Do not reuse them: MARKDOWN_TEMPLATE_R0001, MARKDOWN_TEMPLATE_R0003 to MARKDOWN_TEMPLATE_R0010, MARKDOWN_TEMPLATE_R0016, MARKDOWN_TEMPLATE_R0019, and MARKDOWN_TEMPLATE_R0028.
export const markdownTemplateErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/markdown-template/diagnostics",
  codes: {
    MARKDOWN_TEMPLATE_R0002: { ...dynamicError, fix: "Bind the condition to a `data.<path>` path that the template may read, or to a JSON literal, such as `:condition=\"data.ready\"`." },
    MARKDOWN_TEMPLATE_B0001: { ...dynamicError, fix: "Pass a path that starts with `./`, ends with `.template.md`, and uses `/` between folders, such as `./review/PULL_REQUEST.template.md`." },
    MARKDOWN_TEMPLATE_B0002: { ...dynamicError, fix: "Remove the empty, `.`, and `..` folders from the path, such as `./review/PULL_REQUEST.template.md` in place of `./review/../PULL_REQUEST.template.md`." },
    MARKDOWN_TEMPLATE_R0011: { ...dynamicError, fix: "Pass a link value in the template data that is a safe URL, such as an `https:` or relative URL without spaces at the ends, control characters, backslashes, or HTML character references." },
    MARKDOWN_TEMPLATE_R0012: { ...dynamicError, fix: "Pass a link value in the template data that is a safe URL, such as an `https:` or relative URL without spaces at the ends, control characters, backslashes, or HTML character references." },
    MARKDOWN_TEMPLATE_R0013: { ...dynamicError, fix: "Pass a link value in the template data that is a safe URL, such as an `https:` or relative URL without spaces at the ends, control characters, backslashes, or HTML character references." },
    MARKDOWN_TEMPLATE_R0014: { ...dynamicError, fix: "Pass the template text as a string to `renderMarkdownTemplate()`, or use `renderMarkdownFile()` with the path of a template file." },
    MARKDOWN_TEMPLATE_R0015: { ...dynamicError, fix: "Write `::else-if` and `::else` blocks only inside the `::if` block that they follow, as in `::if{:condition=\"data.ready\"}` ... `::else` ... `::`." },
    MARKDOWN_TEMPLATE_R0017: { ...dynamicError, fix: "Add the value that the message names to the `data` that you pass to the renderer, or remove its binding from the template." },
    MARKDOWN_TEMPLATE_R0018: { ...dynamicError, fix: "Bind the value that the message names to a string, number, or boolean in `data`, or use `:insert{:markdown=\"data.<path>\"}` for a Markdown fragment." },
    MARKDOWN_TEMPLATE_R0020: { ...dynamicError, fix: "Give each `:insert` a bound `:markdown` prop with an allowed `data.<path>` that holds a Markdown string, such as `:insert{:markdown=\"data.summary\"}`." },
    MARKDOWN_TEMPLATE_R0021: { ...dynamicError, fix: "Put the `:insert` on its own line with blank lines around it, or pass a fragment that is one paragraph." },
    MARKDOWN_TEMPLATE_R0022: { ...dynamicError, fix: "Remove the condition from the `::else` block, or use `::else-if{:condition=\"data.<path>\"}` for a branch with a condition." },
    MARKDOWN_TEMPLATE_R0023: { ...dynamicError, fix: "Put `::else` last in its `::if` block, and move each `::else-if` before it." },
    MARKDOWN_TEMPLATE_R0024: { ...dynamicError, fix: "Give `::if` and `::else-if` a bound `:condition` or `:value` prop, such as `::if{:condition=\"data.ready\"}`, and use only the `eq`, `neq`, `gt`, `gte`, `lt`, and `lte` props next to it." },
    MARKDOWN_TEMPLATE_R0025: { ...dynamicError, fix: "Write `::else-if` and `::else` blocks only inside the `::if` block that they follow, as in `::if{:condition=\"data.ready\"}` ... `::else` ... `::`." },
    MARKDOWN_TEMPLATE_R0026: { ...dynamicError, fix: "Put `::else` last in its `::if` block, and move each `::else-if` before it." },
    MARKDOWN_TEMPLATE_R0027: { ...dynamicError, fix: "Remove the condition from the `::else` block, or use `::else-if{:condition=\"data.<path>\"}` for a branch with a condition." },
    MARKDOWN_TEMPLATE_R0029: { ...dynamicError, fix: "Add a closing `::` line for each `::if`, `::else-if`, and `::else` block of the template." },
    MARKDOWN_TEMPLATE_R0030: { ...dynamicError, fix: "Remove the `:srcdoc` binding from the template, and write the iframe content as static markup." },
    MARKDOWN_TEMPLATE_R0031: { ...dynamicError, fix: "Remove the binding of the HTML event-handler attribute, such as `:onclick`, from the template." },
    MARKDOWN_TEMPLATE_R0032: { ...dynamicError, fix: "Remove the `:style` binding from the template, and use a static `style` attribute or a class." },
    MARKDOWN_TEMPLATE_R0033: { ...dynamicError, fix: "Write the link as `[label](){:href=\"data.<path>\"}` in place of `{{ }}` in the link destination." },
  },
})
