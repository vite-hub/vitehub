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
    DOCS_BASE_EMPTY: {
      why: ({ base, path }: { base: string, path: string }) => `[@vite-hub/docs] With docs.sources, the docs base defaults to ${base}. No page is at or below it, so pages such as ${path} render as standalone articles.`,
      fix: "To show sections, set `docs: { base: '/' }` in nuxt.config.ts or mount the pages at `/docs`. To keep the pages standalone, set `docs: { base: '/docs' }`.",
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
    DOCS_RUNNABLE_CATALOG_VERSION_MISSING: {
      why: ({ catalog, name }: { catalog: string, name: string }) => `[@vite-hub/docs] A fixture of docs.runnable uses catalog:, but the pnpm catalog "${catalog}" has no version of ${name}.`,
      fix: "Set `docs.runnable.pnpmWorkspace` to the folder of pnpm-workspace.yaml, and add the package to the catalog that the specifier names.",
    },
    DOCS_RUNNABLE_DEV_SERVER_MISSING: {
      why: ({ fixture, name }: { fixture: string, name: string }) => `[@vite-hub/docs] The dev script of the fixture ${fixture} runs ${name}, but ${name} is in devDependencies. The snapshot of docs.runnable installs dependencies only, so the workspace cannot start.`,
      fix: "Move the package that the message names from `devDependencies` to `dependencies` in the package.json of the fixture.",
    },
    DOCS_RUNNABLE_FIXTURE_FILE_MISSING: {
      why: ({ fixture, label, page }: { fixture: string, label: string, page: string }) => `[@vite-hub/docs] ${page} shows ${label}, but the fixture ${fixture} has no such file.`,
      fix: "Add the file to the fixture folder, or correct the label of the code block in the lesson page.",
    },
    DOCS_RUNNABLE_PACK_FAILED: {
      why: ({ name }: { name: string }) => `[@vite-hub/docs] pnpm pack wrote no tarball for ${name}, so the snapshot of docs.runnable cannot install it.`,
      fix: "Run `pnpm pack` in the folder of the package that the message names, and fix the error that it shows.",
    },
    DOCS_RUNNABLE_PAGE_MISSING: {
      why: ({ page }: { page: string }) => `[@vite-hub/docs] docs.runnable names the page ${page}, but the docs site has no page at that URL.`,
      fix: "Set `page` of the lesson, or `docs.runnable.start`, to the URL of a docs page, such as `/docs/getting-started/first-agent`.",
    },
    DOCS_RUNNABLE_STEPS_MISSING: {
      why: ({ page }: { page: string }) => `[@vite-hub/docs] ${page} has no ::tutorial-step blocks, so docs.runnable cannot build its lesson.`,
      fix: "Add `::tutorial-step{title=\"...\"}` blocks to the lesson page, or remove the lesson from `docs.runnable.lessons`.",
    },
    DOCS_RUNNABLE_TITLE_MISSING: {
      why: ({ block }: { block: string }) => `[@vite-hub/docs] A ::tutorial-step block has no title: ${block}`,
      fix: "Give the block a title, such as `::tutorial-step{title=\"Add the route\"}`.",
    },
    DOCS_RUNNABLE_WORKSPACE_PACKAGE_MISSING: {
      why: ({ name }: { name: string }) => `[@vite-hub/docs] A fixture of docs.runnable uses workspace:, but the pnpm workspace has no package named ${name}.`,
      fix: "Set `docs.runnable.pnpmWorkspace` to the folder of pnpm-workspace.yaml, and check that its `packages` patterns include the package.",
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
    DOCS_WORKSPACE_DIR_MISSING: {
      why: ({ dir, page }: { dir: string, page: string }) => `The docs page ${page} runs the folder ${dir}, which does not exist.`,
      fix: "Set `dir` of each example in `examples` to a folder of the app relative to the app root, or set `fixture` of a learn page to a folder in the `docs.runnable.fixtures` folder (`fixtures` by default).",
    },
    DOCS_WORKSPACE_ID_COLLISION: {
      why: ({ id, pages }: { id: string, pages: readonly string[] }) => `The docs pages ${pages.join(" and ")} get the same workspace id ${id}, so their lessons, examples, and snapshots would overwrite each other.`,
      fix: "Rename one of the pages. The id is the page path in lower case with each run of other characters as `-`, so `/docs/a/b` and `/docs/a-b` are both `docs-a-b`.",
    },
    DOCS_WORKSPACE_READONLY_MISSING: {
      why: ({ dir, example, page, path }: { dir: string, example: string, page: string, path: string }) => `The example ${example} of the docs page ${page} marks ${path} read-only, but ${dir} has no text file at that path.`,
      fix: "Set each path in `readonly` to a text file of the example's `dir`, relative to that folder, such as `model.ts`. Binary files, such as `weights.bin`, are never editable, so leave them out.",
    },
    DOCS_WORKSPACE_RENDER_MISSING: {
      why: ({ file, page }: { file: string, page: string }) => `The docs page ${page} renders with ${file}, which does not exist.`,
      fix: "Set `render` to a module relative to the app root, such as `app/playground/render.ts`, whose default export takes the files and returns `{ html }`.",
    },
    DOCS_WORKSPACE_TAB_MISSING: {
      why: ({ file, page, tab }: { file: string, page: string, tab: string }) => `The docs page ${page} has the tab \`${tab}\`, but ${file} does not exist.`,
      fix: "Add the component that draws the tab, or remove the tab from `tabs`. The tab `messages` renders `app/components/playground/PlaygroundTabMessages.vue`, which reads the workspace with `useWorkspace()`.",
    },
    DOCS_WORKSPACE_VITEHUB_MISSING: {
      why: ({ pages }: { pages: readonly string[] }) => `[@vite-hub/docs] These pages run apps in a WebContainer, which needs vite-hub/nuxt for cross-origin isolation: ${pages.join(", ")}.`,
      fix: "Add `vite-hub/nuxt` and `@vite-hub/web-container` to the app, or give each playground page a `render` module, which runs without a WebContainer.",
    },
  },
})
