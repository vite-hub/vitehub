import examples from "#docs/example-sources"
import imageSizes from "#docs/image-sizes"
import parser, { githubRepo } from "#docs/parser"
import { defu } from "defu"
import { createDocsParser, docsImageSizes } from "../markdown.ts"
import type { DocsParserOptions } from "../markdown.ts"

// `#123` links to the site's issues unless the parser names another repository or turns references off.
const references = githubRepo ? { github: { references: { repo: githubRepo } } } : {}
/**
 * The one parser configuration of the site. The runtime Content of the page route and search, drafts, and credits parse
 * with it. The images of the app's `public/` folder get their size after the site's own plugins.
 */
export const docsParserOptions: DocsParserOptions = {
  exampleSources: examples,
  ...parser,
  comarkUi: defu(parser.comarkUi, references),
  plugins: [...parser.plugins ?? [], docsImageSizes(imageSizes)],
}
export const parseDocsDocument = createDocsParser(docsParserOptions)
