import { browserProviderError } from "../errors.ts"

import type { CDPClient } from "../controllers/cdp.ts"
import type {
  BrowserDownload,
  BrowserLocator,
  BrowserLocatorOptions,
  BrowserLocatorWaitOptions,
  BrowserPage,
} from "../types.ts"

const DEFAULT_TIMEOUT_MS = 30_000

interface AttachedPage {
  page: BrowserPage
  send<TResult = unknown>(method: string, params?: object): Promise<TResult>
}

interface LocatorSpec {
  hasText?: string
  selector: string
}

function locatorExpression(
  operation: "click" | "count" | "fill" | "inputValue" | "visible",
  locator: LocatorSpec,
  value?: string,
) {
  return `(() => {
    const spec = ${JSON.stringify(locator)};
    const elements = [...document.querySelectorAll(spec.selector)]
      .filter(element => !spec.hasText || element.textContent?.includes(spec.hasText));
    const element = elements[0];
    if (${JSON.stringify(operation)} === "count") return elements.length;
    if (${JSON.stringify(operation)} === "visible") {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    }
    if (!(element instanceof HTMLElement)) throw new Error("Browser locator did not match an HTML element");
    if (${JSON.stringify(operation)} === "click") {
      element.click();
      return true;
    }
    if (${JSON.stringify(operation)} === "inputValue") {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
        throw new Error("Browser locator does not support inputValue() for this element");
      }
      return element.value;
    }
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
      throw new Error("Browser locator does not support fill() for this element");
    }
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) throw new Error("Browser locator could not set the element value");
    setter.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`
}

function evaluateResult<TResult>(result: { exceptionDetails?: unknown, result?: { value?: TResult } }, operation: string): TResult {
  if (result.exceptionDetails) throw browserProviderError("cdp", operation)
  return result.result?.value as TResult
}

async function withTimeout<TResult>(promise: Promise<TResult>, timeoutMs: number, operation: string): Promise<TResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(browserProviderError("cdp", operation)), timeoutMs)
      }),
    ])
  }
  finally {
    if (timer) clearTimeout(timer)
  }
}

class CDPBrowserLocator implements BrowserLocator {
  constructor(
    private readonly send: AttachedPage["send"],
    private readonly locator: LocatorSpec,
  ) {}

  private async evaluate<TResult>(operation: Parameters<typeof locatorExpression>[0], value?: string): Promise<TResult> {
    const result = await this.send<{
      exceptionDetails?: unknown
      result?: { value?: TResult }
    }>("Runtime.evaluate", {
      awaitPromise: true,
      expression: locatorExpression(operation, this.locator, value),
      returnByValue: true,
    })
    return evaluateResult(result, `${operation} Browser locator ${JSON.stringify(this.locator.selector)}`)
  }

  async click(): Promise<void> {
    await this.evaluate("click")
  }

  async count(): Promise<number> {
    return await this.evaluate<number>("count")
  }

  async fill(value: string): Promise<void> {
    await this.evaluate("fill", value)
  }

  async inputValue(): Promise<string> {
    return await this.evaluate<string>("inputValue")
  }

  async waitFor(options: BrowserLocatorWaitOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs
    do {
      if (await this.evaluate<boolean>("visible")) return
      await new Promise(resolve => setTimeout(resolve, 50))
    } while (Date.now() < deadline)
    throw browserProviderError("cdp", `wait for Browser locator ${JSON.stringify(this.locator.selector)}`)
  }
}

export async function attachCDPPage(client: CDPClient): Promise<AttachedPage> {
  const targets = await client.send<{
    targetInfos?: Array<{ targetId?: string, type?: string }>
  }>("Target.getTargets")
  const targetId = targets.targetInfos?.find(target => target.type === "page")?.targetId
  if (!targetId) throw browserProviderError("cdp", "find the browser page target")

  const attached = await client.send<{ sessionId?: string }>("Target.attachToTarget", {
    flatten: true,
    targetId,
  })
  if (!attached.sessionId) throw browserProviderError("cdp", "attach to the browser page target")
  const sessionId = attached.sessionId
  const send = <TResult>(method: string, params: object = {}) => client.send<TResult>(method, params, sessionId)
  await send("Page.enable")

  const page: BrowserPage = {
    async goto(url, options = {}) {
      await withTimeout((async () => {
        await send("Page.navigate", { url })
        await send("Runtime.evaluate", {
          awaitPromise: true,
          expression: 'document.readyState === "complete" ? true : new Promise(resolve => addEventListener("load", () => resolve(true), { once: true }))',
          returnByValue: true,
        })
      })(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS, `navigate to ${JSON.stringify(url)}`)
    },
    locator(selector: string, options: BrowserLocatorOptions = {}) {
      return new CDPBrowserLocator(send, { selector, ...options })
    },
    async press(key) {
      await send("Input.dispatchKeyEvent", { key, type: "keyDown" })
      await send("Input.dispatchKeyEvent", { key, type: "keyUp" })
    },
    async waitForDownload(action, options = {}) {
      try {
        await client.send("Browser.setDownloadBehavior", {
          behavior: "default",
          eventsEnabled: true,
        })
      }
      catch {
        // Kitesurf may omit this command while still emitting download events.
      }
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      let stopPage = () => {}
      let stopBrowser = () => {}
      let timer: ReturnType<typeof setTimeout> | undefined
      const download = new Promise<BrowserDownload>((resolve, reject) => {
        const receive = (params: unknown) => {
          const event = params as { suggestedFilename?: unknown, url?: unknown }
          if (typeof event.url !== "string" || typeof event.suggestedFilename !== "string") return
          resolve({ suggestedFilename: event.suggestedFilename, url: event.url })
        }
        stopPage = client.on("Page.downloadWillBegin", receive)
        stopBrowser = client.on("Browser.downloadWillBegin", receive)
        timer = setTimeout(
          () => reject(browserProviderError("cdp", "wait for the browser download")),
          timeoutMs,
        )
      })
      try {
        await action()
        return await download
      }
      finally {
        stopPage()
        stopBrowser()
        if (timer) clearTimeout(timer)
      }
    },
  }

  return { page, send }
}
