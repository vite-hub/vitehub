import type {
  Browser,
  BrowserContext,
  Page,
} from "playwright-core"
import type { PlaywrightClient } from "../controllers/playwright.ts"
import type { PlaywrightBrowserConnection } from "./connections.ts"
import type { BrowserControllerLease } from "../types.ts"

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

export async function attachPlaywrightBrowser(
  browser: Browser,
  connection: PlaywrightBrowserConnection,
): Promise<BrowserControllerLease<PlaywrightClient>> {
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
}
