import type { AgentToolSet } from "../../types.ts"
import type {
  WebReadToolInput,
  WebSearchProviderInput,
  WebSearchResult,
  WebSearchToolInput,
} from "./types.ts"
import { resolveWebSearchProvider } from "./credentials.ts"

interface AskwebModule {
  create: (name: string, config?: { apiKey?: string, baseURL?: string }) => {
    search: (query: string, options?: WebSearchOptions) => Promise<WebSearchResult[]>
  }
  readUrl: (url: string, options?: { format?: "markdown" | "text", maxTokens?: number }) => Promise<unknown>
}

interface WebSearchOptions {
  excludeDomains?: string[]
  includeDomains?: string[]
  maxResults?: number
}

const searchInputKeys = new Set([
  "excludeDomains",
  "includeDomains",
  "maxResults",
  "query",
])

const readInputKeys = new Set([
  "maxTokens",
  "url",
])

function assertKnownInput(input: Record<string, unknown>, allowed: Set<string>, toolName: string) {
  const unsupported = Object.keys(input).filter(key => !allowed.has(key))
  if (unsupported.length) {
    throw new TypeError(`[vitehub] ${toolName} does not support option${unsupported.length === 1 ? "" : "s"}: ${unsupported.join(", ")}.`)
  }
}

function requireObject(input: unknown, toolName: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`[vitehub] ${toolName} input must be an object.`)
  }
  return input as Record<string, unknown>
}

async function loadAskweb(): Promise<AskwebModule> {
  try {
    const specifier = "askweb"
    return await import(/* @vite-ignore */ specifier) as AskwebModule
  }
  catch (error) {
    throw new Error("[vitehub] webSearch({ mode: \"tool\" }) requires askweb to be installed by the application. Install askweb@0.2.0 or use webSearch({ mode: \"model\" }).", { cause: error })
  }
}

function normalizeSearchInput(input: unknown): { options: WebSearchOptions, query: string } {
  const value = requireObject(input, "web_search") as WebSearchToolInput & Record<string, unknown>
  assertKnownInput(value, searchInputKeys, "web_search")
  if (typeof value.query !== "string" || !value.query.trim()) {
    throw new TypeError("[vitehub] web_search requires a non-empty query.")
  }
  return {
    options: {
      excludeDomains: value.excludeDomains,
      includeDomains: value.includeDomains,
      maxResults: value.maxResults,
    },
    query: value.query,
  }
}

function normalizeReadInput(input: unknown): WebReadToolInput {
  const value = requireObject(input, "web_read") as WebReadToolInput & Record<string, unknown>
  assertKnownInput(value, readInputKeys, "web_read")
  if (typeof value.url !== "string" || !value.url.trim()) {
    throw new TypeError("[vitehub] web_read requires a non-empty url.")
  }
  return value
}

export function createWebSearchToolSet(provider: WebSearchProviderInput): AgentToolSet {
  const resolvedProvider = resolveWebSearchProvider(provider)
  let askweb: Promise<AskwebModule> | undefined

  return {
    web_read: {
      description: "Read a web page by URL and return normalized Markdown or text.",
      name: "web_read",
      async execute(input) {
        const value = normalizeReadInput(input)
        askweb ||= loadAskweb()
        const { readUrl } = await askweb
        return await readUrl(value.url, {
          format: "markdown",
          maxTokens: value.maxTokens,
        })
      },
    },
    web_search: {
      description: "Search the web with the configured provider.",
      name: "web_search",
      async execute(input) {
        const { options, query } = normalizeSearchInput(input)
        askweb ||= loadAskweb()
        const { create } = await askweb
        const searchProvider = create(resolvedProvider.name, {
          apiKey: resolvedProvider.apiKey,
          baseURL: resolvedProvider.baseURL,
        })
        return await searchProvider.search(query, options)
      },
    },
  }
}
