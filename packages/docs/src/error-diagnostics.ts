import { defineDiagnostics } from "nostics"

// Each code identifies one ViteHub failure site. Keep published codes stable.
export const docsErrorDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/docs-site/diagnostics",
  codes: {
    // Named errors. Keep these codes in alphabetical order.
    DOCS_ASSISTANT_AGENTS_MISSING: {
      why: ({ agent }: { agent: string }) => `[@vite-hub/docs] docs.assistant needs ViteHub Agents to answer from the "${agent}" Agent.`,
      fix: "Add `vite-hub/nuxt` to modules and set `vitehub: { agent: true, connections: true }` in nuxt.config.ts, or set `docs: { assistant: false }`.",
    },
    DOCS_ASSISTANT_PAGE_MISSING: {
      why: ({ path }: { path: string }) => `[@vite-hub/docs] The docs assistant's Workspace has no page at ${path}. The pages changed after the Workspace listed them.`,
      fix: "Ask the question again. The next Invocation lists the current pages.",
    },
    DOCS_COMMENTS_DATABASE_OFF: {
      why: "[@vite-hub/docs] Docs sites on vite-hub/nuxt have Comments on, which keeps threads in the Database, but vitehub sets database: false.",
      fix: "Remove `database: false` from the `vitehub` options in nuxt.config.ts, or set `docs: { comments: false }`.",
    },
    DOCS_COMMENTS_PACKAGE_MISSING: {
      why: "[@vite-hub/docs] Docs sites on vite-hub/nuxt have Comments on, which needs @vite-hub/comments.",
      fix: "Run `pnpm add @vite-hub/comments`, or set `docs: { comments: false }` in nuxt.config.ts.",
    },
    DOCS_COMMENTS_VITEHUB_MISSING: {
      why: "[@vite-hub/docs] docs.comments needs vite-hub/nuxt, which keeps the threads in a ViteHub Database.",
      fix: "Add `vite-hub/nuxt` to modules in nuxt.config.ts, or set `docs: { comments: false }`.",
    },
    DOCS_CONTENT_INVALID: {
      why: ({ details, file }: { details: string, file: string }) => `Invalid docs frontmatter in ${file}: ${details}`,
      fix: "Fix the field that the message names in the page frontmatter or the `.navigation.yml` file. The schemas are `docsPageSchema` and `docsSectionSchema` from `@vite-hub/docs`.",
    },
    DOCS_EXAMPLE_MISSING: {
      why: ({ name }: { name: string }) => `::example names "${name}", but the examples folder has no ${name}.vue.`,
      fix: "Add the component that the message names to the examples folder of the docs, or correct the `name` of the `::example` block.",
    },
    DOCS_LINKS_BROKEN: {
      why: ({ problems }: { problems: readonly string[] }) => `Broken docs links:\n${problems.map(problem => `- ${problem}`).join("\n")}`,
      fix: "Fix each link that the message lists in the page that it names, or add the target to `checkDocsLinks({ excludeLinks })` when it is served outside the docs output.",
    },
    DOCS_OUTPUT_MISSING: {
      why: ({ root }: { root: string }) => `Docs output does not exist: ${root}`,
      fix: "Build the docs site first, or pass `checkDocsLinks({ dir })` the folder that the build writes.",
    },
    DOCS_REDIRECTS_BROKEN: {
      why: ({ problems }: { problems: readonly string[] }) => `Docs redirects break links:\n${problems.map(problem => `- ${problem}`).join("\n")}`,
      fix: "Point each redirect route rule that the message lists to a docs page, or remove the rule when the page that it hides still exists.",
    },
    DOCS_SEO_FAILED: {
      why: ({ problems }: { problems: readonly string[] }) => `Docs pages fail the search checks:\n${problems.map(problem => `- ${problem}`).join("\n")}`,
      fix: "Fix each page that the message lists, or set `docs: { seoAudit: \"warn\" }` to log the problems without stopping the build.",
    },
    DOCS_SOURCE_MOUNT_INVALID: {
      why: ({ mount }: { mount: string }) => `Invalid docs source mount: ${mount}`,
      fix: "Set the `mount` of the docs source to a URL path such as `/guide`, without `.`, `..`, `?`, `#`, or backslash segments.",
    },
  },
})
