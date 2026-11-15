import { defineDiagnostics } from "nostics"

// Each code identifies one ViteHub failure site. Keep published codes stable.
export const docsErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/docs-site/diagnostics",
  codes: {
    // Named errors. Keep these codes in alphabetical order.
    DOCS_EXAMPLE_MISSING: {
      why: ({ name }: { name: string }) => `::example names "${name}", but the examples folder has no ${name}.vue.`,
      fix: "Add the component that the message names to the examples folder of the docs, or correct the `name` of the `::example` block.",
    },
    DOCS_OUTPUT_MISSING: {
      why: ({ root }: { root: string }) => `Docs output does not exist: ${root}`,
      fix: "Build the docs site first, or pass `checkDocsLinks({ dir })` the folder that the build writes.",
    },
    DOCS_SOURCE_MOUNT_INVALID: {
      why: ({ mount }: { mount: string }) => `Invalid docs source mount: ${mount}`,
      fix: "Set the `mount` of the docs source to a URL path such as `/guide`, without `.`, `..`, `?`, `#`, or backslash segments.",
    },
  },
})
