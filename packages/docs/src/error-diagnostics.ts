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
    DOCS_SEO_DESCRIPTION_INVALID: {
      why: ({ problems }: { problems: readonly string[] }) => `Docs pages have no description, one of the wrong length, or the description of another page:\n${problems.map(problem => `- ${problem}`).join("\n")}`,
      fix: "Set `description` in the frontmatter of each page that the message lists, with 70 to 160 characters, and give each page its own.",
    },
    DOCS_SEO_FAILED: {
      why: ({ problems }: { problems: readonly string[] }) => `Docs pages fail the search checks:\n${problems.map(problem => `- ${problem}`).join("\n")}`,
      fix: "Fix each page that the message lists, or set `docs: { seoAudit: \"warn\" }` to report them as hints in `.vitehub/hints.json` without stopping the build.",
    },
    DOCS_SEO_HEADINGS_INVALID: {
      why: ({ problems }: { problems: readonly string[] }) => `Docs pages have headings that search engines flag:\n${problems.map(problem => `- ${problem}`).join("\n")}`,
      fix: "Give each page that the message lists one `h1`, and go down one heading level at a time, such as `##` and then `###`.",
    },
    DOCS_SEO_HTML_TOO_LARGE: {
      why: ({ problems }: { problems: readonly string[] }) => `Docs pages have more HTML than the 2 MB that Googlebot reads:\n${problems.map(problem => `- ${problem}`).join("\n")}`,
      fix: "Split each page that the message lists, or show long lists with a component that renders less markup than a Markdown table.",
    },
    DOCS_SEO_LINK_NOT_PAGE: {
      why: ({ problems }: { problems: readonly string[] }) => `Docs pages link to a redirect or to an endpoint, not to a page:\n${problems.map(problem => `- ${problem}`).join("\n")}`,
      fix: "Link to the page that the redirect goes to. Write the URL of an endpoint, such as `/mcp`, as code instead of a link.",
    },
    DOCS_SEO_OPEN_GRAPH_INCOMPLETE: {
      why: ({ problems }: { problems: readonly string[] }) => `Docs pages have incomplete Open Graph tags, so their share previews are incomplete:\n${problems.map(problem => `- ${problem}`).join("\n")}`,
      fix: "Set the head of each page that the message lists with `useDocsSeo()`. A page that writes its own head must set `og:title`, `og:type`, `og:image`, and `og:url`.",
    },
    DOCS_SEO_PAGE_THIN: {
      why: ({ problems }: { problems: readonly string[] }) => `Docs pages have fewer than 150 words, and site audits call them thin content:\n${problems.map(problem => `- ${problem}`).join("\n")}`,
      fix: "Write at least 150 words on each page that the message lists, or merge it into a related page.",
    },
    DOCS_SEO_PAGE_UNLINKED: {
      why: ({ problems }: { problems: readonly string[] }) => `No other page links to these docs pages, so crawlers find them only in the sitemap:\n${problems.map(problem => `- ${problem}`).join("\n")}`,
      fix: "Link each page that the message lists from the navigation, the footer, or a related page.",
    },
    DOCS_SEO_SITEMAP_NOT_PAGE: {
      why: ({ problems }: { problems: readonly string[] }) => `The sitemap lists URLs that are not prerendered pages:\n${problems.map(problem => `- ${problem}`).join("\n")}`,
      fix: "Remove each URL that the message lists from the sitemap, list the page that it redirects to, or make it a page.",
    },
    DOCS_SEO_TITLE_INVALID: {
      why: ({ problems }: { problems: readonly string[] }) => `Docs pages have no title, one of the wrong length, or the title of another page:\n${problems.map(problem => `- ${problem}`).join("\n")}`,
      fix: "Set `title` in the frontmatter of each page that the message lists, with 10 to 60 characters, and give each page its own. Use `seo.title` when the heading must stay.",
    },
    DOCS_SOURCE_MOUNT_INVALID: {
      why: ({ mount }: { mount: string }) => `Invalid docs source mount: ${mount}`,
      fix: "Set the `mount` of the docs source to a URL path such as `/guide`, without `.`, `..`, `?`, `#`, or backslash segments.",
    },
  },
})
