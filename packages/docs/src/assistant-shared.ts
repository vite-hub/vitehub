import { defineAgent } from "@vite-hub/agent"
import { rateLimit } from "@vite-hub/agent/capabilities"
import { webChat } from "@vite-hub/agent/channels"
import { createRateLimiter } from "@vite-hub/rate-limit"
import { memoryRateLimitDriver } from "@vite-hub/rate-limit/drivers/memory"
import { custom } from "@vite-hub/workspace"

import { docsAppPath } from "./navigation.ts"

import type { AgentAdapterInstructions, AgentAdapterMetadataContext, AgentCapabilityDefinition, AgentSettings, WorkspaceAgentDefinition } from "@vite-hub/agent"
import type { RateLimitIdentity } from "@vite-hub/agent/capabilities"
import type { RateLimitPolicy } from "@vite-hub/rate-limit"
import type { WorkspaceSource } from "@vite-hub/workspace"

/** Invocation context key that holds the path of the page the reader has open. */
export const docsPageContextKey = "docsPage"

const docsRules = `You answer questions from readers of this documentation site.

The pages of the site are Markdown files in the \`pages\` folder of your working directory. Search and read them with read-only shell commands such as \`rg\`, \`ls\`, and \`cat\` before you answer.

A page URL is its file path without \`pages\` and \`.md\`. An \`index.md\` file is the URL of its folder. For example, \`pages/docs/guide/setup.md\` is \`/docs/guide/setup\`, and \`pages/docs/guide/index.md\` is \`/docs/guide\`. Apply the site's app base, when specified below, to every page link.

- Answer only from these pages. Do not use what you know about the product from other sources.
- Link each page that you used, as a Markdown link to its URL, for example [Setup](/docs/guide/setup).
- If the pages do not answer the question, say that the documentation does not cover it. Do not guess.
- Keep answers short and concrete. Put code in fenced code blocks.
- Do not change files. Do not run commands that do not read the pages.

{{{ instructions }}}`

/** Page paths only: the value goes into the instructions, so it must not carry Markdown or template syntax. */
const pagePathPattern = /^\/[\w\-./~%]{0,299}$/

/** Returns the page path from a chat request body, or an empty string when it is missing or not a plain path. */
export function docsPageFromBody(body: Readonly<Record<string, unknown>>): string {
  const page = body.page
  return typeof page === "string" && pagePathPattern.test(page) && !page.includes("..") ? page : ""
}

function currentPageInstructions({ context }: Pick<AgentAdapterMetadataContext, "context">): string | undefined {
  const page = context.get(docsPageContextKey)
  const appBase = context.get("docsAppBase")
  return [
    typeof appBase === "string" && appBase !== "/" ? `Prefix every page link with ${appBase}, for example [Setup](${docsAppPath("/docs/guide/setup", appBase)}). The reader's page path below is relative to this app base.` : "",
    typeof page === "string" && page ? `The reader has the page ${page} open. When the question is not clear, answer for that page first.` : "",
  ].filter(Boolean).join("\n\n") || undefined
}

export interface DocsRateLimitOptions {
  /** Questions per window. Defaults to 30. */
  limit?: number
  /** Defaults to `1h`. */
  window?: RateLimitPolicy["window"]
  /**
   * Who shares one budget. Defaults to the whole site, because anonymous readers have no stable identity. Use `"ip"`
   * with `trustedIpHeaders` behind a proxy that sets them, or a function of the Invocation context.
   */
  identity?: RateLimitIdentity
  trustedIpHeaders?: string[]
}

/**
 * The assistant's question limit, with the id `docs-rate-limit` that replaces the default one. Counters live in process
 * memory: they reset on restart and do not span processes.
 */
export function docsRateLimit(options: DocsRateLimitOptions = {}): AgentCapabilityDefinition {
  return rateLimit({
    id: "docs-rate-limit",
    identity: options.identity ?? (() => "site"),
    trustedIpHeaders: options.trustedIpHeaders,
    limiter: createRateLimiter({ driver: memoryRateLimitDriver(), enforcement: "strict", limit: options.limit ?? 30, name: "docs-assistant", window: options.window ?? "1h" }),
    message: "The docs assistant reached its limit of questions for now. Try again later.",
  })
}

/** The model of the Worker build. A model ID from the ChatGPT plan catalog: `vitehub connections models chatgpt`. */
export const docsAssistantModel = "gpt-6.1-sol"

/**
 * The pages Source: every page of the docs site, read from the same manifest and files as the site's Content. It covers
 * `docs.dir` and `docs.sources`, and lays each page out at its URL path, as the docs rules expect. The Workspace reads it
 * for each Invocation (`lazy`, no cache), so a page that development adds shows at once, and a Worker reads the pages
 * that the docs build packed, with no second copy. It loads the docs server modules on the first read, so the Agent
 * needs the `@vite-hub/docs` Nuxt module.
 */
export function docsPagesSource(): WorkspaceSource {
  return custom({
    name: "docs-pages",
    materialize: "lazy",
    cache: false,
    getKeys: async () => (await import("./runtime/assistant-pages.ts")).listDocsAssistantPagePaths(),
    getItem: async key => ({ key, content: await (await import("./runtime/assistant-pages.ts")).readDocsAssistantPage(key), mediaType: "text/markdown" }),
  })
}

/** The docs rules, the developer's instructions in their place, and the reader's page. */
export const docsInstructions: AgentAdapterInstructions = { template: [docsRules, currentPageInstructions] }

/**
 * The parts of the docs assistant that do not depend on the host: a read-only Workspace with the pages of the docs site,
 * the `web` Chat Channel with the reader's current page, a site-wide rate limit, and Driver capacity.
 */
export function defineDocsAssistant(driver: NonNullable<AgentSettings["driver"]>, capabilities: AgentCapabilityDefinition[] = []): WorkspaceAgentDefinition {
  return defineAgent({
    description: "Answers reader questions from the documentation pages.",
    driver,
    workspace: {
      mode: "read",
      // The root of a `glob()` Source that replaces the pages.
      sourceRootDir: process.cwd(),
      sources: { pages: docsPagesSource() },
    },
    channels: {
      web: webChat({
        route: {
          admission: {
            context: ({ body }) => {
              const appBase = docsPageFromBody({ page: Reflect.get(body, "appBase") })
              return { context: { [docsPageContextKey]: docsPageFromBody(body), ...(appBase && appBase !== "/" && !appBase.startsWith("//") ? { docsAppBase: appBase } : {}) } }
            },
          },
        },
      }),
    },
    capabilities: [docsRateLimit(), ...capabilities],
    budget: {
      // Usage is known when an answer finishes, so this records expensive answers. It does not stop one.
      tokens: 200_000,
      capacity: { concurrency: 2, queue: { maxPending: 8, timeout: 120_000 } },
    },
  })
}
