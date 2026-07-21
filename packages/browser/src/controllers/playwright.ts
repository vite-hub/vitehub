import { BrowserProviderError } from "../errors.ts"

import type {
  Browser,
  BrowserContext,
  BrowserType,
  Page,
} from "playwright-core"
import type { BrowserController } from "../types.ts"
import type { PlaywrightBrowserConnection } from "../internal/connections.ts"

export interface PlaywrightClient {
  browser: Browser
  context: BrowserContext
  page: Page
}

export interface PlaywrightControllerOptions {
  chromium?: Pick<BrowserType, "connectOverCDP">
  cloudflare?: {
    connect(binding: unknown, sessionId: string): Promise<Browser>
  }
}

async function loadChromium(): Promise<Pick<BrowserType, "connectOverCDP">> {
  try {
    return (await import("playwright-core")).chromium
  }
  catch (error) {
    throw new BrowserProviderError("playwright", "load playwright-core", { cause: error })
  }
}

async function loadCloudflare(): Promise<NonNullable<PlaywrightControllerOptions["cloudflare"]>> {
  try {
    return await import("@cloudflare/playwright") as unknown as NonNullable<PlaywrightControllerOptions["cloudflare"]>
  }
  catch (error) {
    throw new BrowserProviderError("playwright", "load @cloudflare/playwright", { cause: error })
  }
}

async function targetId(context: BrowserContext, page: Page): Promise<string | undefined> {
  const cdp = await context.newCDPSession(page)
  try {
    const result = await cdp.send("Target.getTargetInfo") as { targetInfo?: { targetId?: unknown } }
    return typeof result.targetInfo?.targetId === "string" ? result.targetInfo.targetId : undefined
  }
  finally {
    await cdp.detach()
  }
}

async function preferredPage(
  contexts: BrowserContext[],
  preferredTargetId: string | undefined,
): Promise<{ context: BrowserContext, page: Page } | undefined> {
  if (!preferredTargetId) return
  for (const context of contexts) {
    for (const page of context.pages()) {
      if (await targetId(context, page) === preferredTargetId) return { context, page }
    }
  }
}

export function playwright(options: PlaywrightControllerOptions = {}): BrowserController<PlaywrightClient, PlaywrightBrowserConnection> {
  return {
    features: { attachExistingSession: true },
    name: "playwright",
    async attach(connection) {
      const browser = connection.kind === "cloudflare-binding"
        ? await (options.cloudflare || await loadCloudflare()).connect(connection.binding, connection.sessionId)
        : await (options.chromium || await loadChromium()).connectOverCDP(connection.endpoint, {
            ...(connection.headers ? { headers: connection.headers } : {}),
          })
      try {
        const contexts = browser.contexts()
        const preferred = await preferredPage(contexts, connection.preferredTargetId)
        const context = preferred?.context || contexts.find(value => value.pages().length > 0) || contexts[0] || await browser.newContext()
        const page = preferred?.page || context.pages()[0] || await context.newPage()
        connection.preferredTargetId ||= await targetId(context, page)
        let released = false
        return {
          client: { browser, context, page },
          preservesSessionOnRelease: false,
          async release() {
            if (released) return
            released = true
            await browser.close()
          },
        }
      }
      catch (error) {
        await browser.close().catch(() => {})
        throw error
      }
    },
  }
}

export type { PlaywrightBrowserConnection } from "../internal/connections.ts"
