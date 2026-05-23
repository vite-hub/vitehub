import type { AgentToolDefinition } from "../../types.ts"

export type WebSearchProvider = "brave" | "exa" | "jina" | "searxng" | "serpapi" | "serpbase" | "tavily" | (string & {})

export type WebSearchCredential =
  | string
  | { unseal: () => string }
  | (() => string | { unseal: () => string } | undefined)

export interface WebSearchProviderOptions {
  apiKey?: WebSearchCredential
  baseURL?: string
  name: WebSearchProvider
}

export type WebSearchProviderInput = WebSearchProvider | WebSearchProviderOptions

export interface WebSearchToolModeOptions {
  mode: "tool"
  provider: WebSearchProviderInput
}

export interface WebSearchModelModeOptions {
  mode: "model"
}

export type WebSearchOptions = WebSearchToolModeOptions | WebSearchModelModeOptions

export interface WebSearchToolInput {
  excludeDomains?: string[]
  includeDomains?: string[]
  maxResults?: number
  query: string
}

export interface WebReadToolInput {
  maxTokens?: number
  url: string
}

export interface WebSearchResult {
  author?: string
  favicon?: string
  highlights?: string[]
  image?: string
  metadata?: Record<string, unknown>
  publishedDate?: string
  score?: number
  snippet: string
  text?: string
  title: string
  url: string
}

export interface WebReadResult {
  content: string
  description?: string
  image?: string
  images?: string[]
  links?: string[]
  metadata?: Record<string, unknown>
  publishedDate?: string
  text?: string
  title?: string
  url: string
}

export type WebSearchToolDefinition = AgentToolDefinition<WebSearchToolInput, WebSearchResult[]>
export type WebReadToolDefinition = AgentToolDefinition<WebReadToolInput, WebReadResult>
