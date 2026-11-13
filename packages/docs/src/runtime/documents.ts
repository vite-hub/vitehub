import examples from "#docs/example-sources"
import parser, { githubRepo } from "#docs/parser"
import { defu } from "defu"
import { createDocsParser } from "../markdown.ts"
import type { DocsParserOptions } from "../markdown.ts"

// `#123` links to the site's issues unless the parser names another repository or turns references off.
const references = githubRepo ? { github: { references: { repo: githubRepo } } } : {}
/** The one parser configuration of the site. The runtime Content of the page route and search, drafts, and credits parse with it. */
export const docsParserOptions: DocsParserOptions = { exampleSources: examples, ...parser, comarkUi: defu(parser.comarkUi, references) }
export const parseDocsDocument = createDocsParser(docsParserOptions)
