import { browserProviderError } from "../errors.ts"

import type { CDPClient } from "../controllers/cdp.ts"
import type {
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
    element.focus();
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
    private readonly clickLocator: (locator: LocatorSpec) => Promise<void>,
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
    await this.clickLocator(this.locator)
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
    const operation = `wait for Browser locator ${JSON.stringify(this.locator.selector)}`
    do {
      const remainingMs = Math.max(0, deadline - Date.now())
      if (await withTimeout(this.evaluate<boolean>("visible"), remainingMs, operation)) return
      await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))))
    } while (Date.now() < deadline)
    throw browserProviderError("cdp", operation)
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
  await send("Page.setLifecycleEventsEnabled", { enabled: true })
  const frameTree = await send<{ frameTree?: { frame?: { id?: string } } }>("Page.getFrameTree")
  const mainFrameId = frameTree.frameTree?.frame?.id

  let clickQueue = Promise.resolve()
  const runClick = async (locator: LocatorSpec, timeoutMs: number) => {
    let navigationRequested = false
    let navigationStopped = false
    let resolveStopped = () => {}
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve
    })
    const stopNavigation = client.on("Page.frameRequestedNavigation", (params, eventSessionId) => {
      const event = params as { frameId?: unknown }
      if (eventSessionId === sessionId && event.frameId === mainFrameId) navigationRequested = true
    })
    const stopLoading = client.on("Page.frameStoppedLoading", (params, eventSessionId) => {
      const event = params as { frameId?: unknown }
      if (eventSessionId !== sessionId || event.frameId !== mainFrameId || !navigationRequested) return
      navigationStopped = true
      resolveStopped()
    })
    try {
      const result = await withTimeout(
        send<{ exceptionDetails?: unknown, result?: { value?: boolean } }>("Runtime.evaluate", {
          awaitPromise: true,
          expression: locatorExpression("click", locator),
          returnByValue: true,
        }),
        timeoutMs,
        `click Browser locator ${JSON.stringify(locator.selector)}`,
      )
      evaluateResult(result, `click Browser locator ${JSON.stringify(locator.selector)}`)
      await new Promise(resolve => setTimeout(resolve, 0))
      if (navigationRequested && !navigationStopped) await stopped
    }
    finally {
      stopNavigation()
      stopLoading()
    }
  }
  const clickLocator = (locator: LocatorSpec) => {
    const deadline = Date.now() + DEFAULT_TIMEOUT_MS
    let expired = false
    const barrier = clickQueue.then(async () => {
      if (expired) return
      await runClick(locator, Math.max(0, deadline - Date.now()))
    })
    clickQueue = barrier.catch(() => {})
    return withTimeout(
      barrier,
      DEFAULT_TIMEOUT_MS,
      `click Browser locator ${JSON.stringify(locator.selector)}`,
    ).catch((error) => {
      expired = true
      throw error
    })
  }

  const page: BrowserPage = {
    async goto(url, options = {}) {
      let navigationLoaderId: string | undefined
      const loadedLoaderIds = new Set<string>()
      let resolveLoad = () => {}
      const loaded = new Promise<void>((resolve) => {
        resolveLoad = resolve
      })
      const stopLoad = client.on("Page.lifecycleEvent", (params, eventSessionId) => {
        const event = params as { loaderId?: unknown, name?: unknown }
        if (eventSessionId !== sessionId || event.name !== "load" || typeof event.loaderId !== "string") return
        loadedLoaderIds.add(event.loaderId)
        if (event.loaderId === navigationLoaderId) resolveLoad()
      })
      try {
        await withTimeout((async () => {
          const navigation = await send<{ errorText?: string, loaderId?: string }>("Page.navigate", { url })
          if (navigation.errorText) {
            throw browserProviderError("cdp", `navigate to ${JSON.stringify(url)} (${navigation.errorText})`)
          }
          navigationLoaderId = navigation.loaderId
          if (navigationLoaderId && !loadedLoaderIds.has(navigationLoaderId)) await loaded
        })(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS, `navigate to ${JSON.stringify(url)}`)
      }
      finally {
        stopLoad()
      }
    },
    locator(selector: string, options: BrowserLocatorOptions = {}) {
      return new CDPBrowserLocator(send, { selector, ...options }, clickLocator)
    },
    async press(key) {
      await send("Input.dispatchKeyEvent", { key, type: "keyDown" })
      await send("Input.dispatchKeyEvent", { key, type: "keyUp" })
    },
  }

  return { page, send }
}
