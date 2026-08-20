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
      if (!(element instanceof Element)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    }
    if (${JSON.stringify(operation)} === "click") {
      if (!(element instanceof Element)) throw new Error("Browser locator did not match an element");
      element.scrollIntoView({ block: "center", inline: "center" });
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) throw new Error("Browser locator matched a non-actionable element");
      const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const hit = document.elementFromPoint(point.x, point.y);
      if (!hit || (hit !== element && !element.contains(hit))) {
        throw new Error("Browser locator target is covered by another element");
      }
      return point;
    }
    if (!(element instanceof HTMLElement)) throw new Error("Browser locator did not match an HTML element");
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

async function withTimeout<TResult>(
  promise: Promise<TResult>,
  timeoutMs: number,
  operation: string,
  onTimeout?: (error: Error) => void,
): Promise<TResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = browserProviderError("cdp", operation)
          onTimeout?.(error)
          reject(error)
        }, timeoutMs)
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
    private readonly assertPageUsable: () => void,
    private readonly invalidatePage: (error: Error) => void,
  ) {}

  private async evaluate<TResult>(operation: Parameters<typeof locatorExpression>[0], value?: string): Promise<TResult> {
    this.assertPageUsable()
    const operationName = `${operation} Browser locator ${JSON.stringify(this.locator.selector)}`
    const result = await withTimeout(this.send<{
      exceptionDetails?: unknown
      result?: { value?: TResult }
    }>("Runtime.evaluate", {
      awaitPromise: true,
      expression: locatorExpression(operation, this.locator, value),
      returnByValue: true,
    }), DEFAULT_TIMEOUT_MS, operationName, this.invalidatePage)
    return evaluateResult(result, operationName)
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
  const setupDeadline = Date.now() + DEFAULT_TIMEOUT_MS
  const setup = <TResult>(promise: Promise<TResult>, operation: string) => withTimeout(
    promise,
    Math.max(0, setupDeadline - Date.now()),
    operation,
  )
  const targets = await setup(client.send<{
    targetInfos?: Array<{ targetId?: string, type?: string }>
  }>("Target.getTargets"), "find the browser page target")
  const targetId = targets.targetInfos?.find(target => target.type === "page")?.targetId
  if (!targetId) throw browserProviderError("cdp", "find the browser page target")

  const attached = await setup(client.send<{ sessionId?: string }>("Target.attachToTarget", {
    flatten: true,
    targetId,
  }), "attach to the browser page target")
  if (!attached.sessionId) throw browserProviderError("cdp", "attach to the browser page target")
  const sessionId = attached.sessionId
  const send = <TResult>(method: string, params: object = {}) => client.send<TResult>(method, params, sessionId)
  await setup(send("Page.enable"), "enable the browser page")
  await setup(send("Page.setLifecycleEventsEnabled", { enabled: true }), "enable browser page lifecycle events")
  const frameTree = await setup(
    send<{ frameTree?: { frame?: { id?: string } } }>("Page.getFrameTree"),
    "read the browser page frame tree",
  )
  const mainFrameId = frameTree.frameTree?.frame?.id

  let pageFailure: unknown
  const assertPageUsable = () => {
    if (pageFailure) throw pageFailure
  }
  const invalidatePage = (error: Error) => {
    pageFailure ??= error
  }
  let pageQueue = Promise.resolve()
  let clickFailure: unknown
  const runClick = async (locator: LocatorSpec) => {
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
      const result = await send<{ exceptionDetails?: unknown, result?: { value?: { x: number, y: number } } }>("Runtime.evaluate", {
        awaitPromise: true,
        expression: locatorExpression("click", locator),
        returnByValue: true,
      })
      const point = evaluateResult<{ x: number, y: number }>(result, `click Browser locator ${JSON.stringify(locator.selector)}`)
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point })
      await send("Input.dispatchMouseEvent", { button: "left", clickCount: 1, type: "mousePressed", ...point })
      await send("Input.dispatchMouseEvent", { button: "left", clickCount: 1, type: "mouseReleased", ...point })
      await new Promise(resolve => setTimeout(resolve, 0))
      if (navigationRequested && !navigationStopped) await stopped
    }
    finally {
      stopNavigation()
      stopLoading()
    }
  }
  const clickLocator = (locator: LocatorSpec) => {
    assertPageUsable()
    if (clickFailure) return Promise.reject(clickFailure)
    let expired = false
    let started = false
    const barrier = pageQueue.then(async () => {
      if (expired) return
      assertPageUsable()
      if (clickFailure) throw clickFailure
      started = true
      await runClick(locator)
    })
    pageQueue = barrier.catch(() => {})
    return withTimeout(
      barrier,
      DEFAULT_TIMEOUT_MS,
      `click Browser locator ${JSON.stringify(locator.selector)}`,
      (error) => {
        expired = true
        if (started) {
          clickFailure ??= error
          invalidatePage(error)
        }
      },
    )
  }

  const page: BrowserPage = {
    async goto(url, options = {}) {
      assertPageUsable()
      const operation = `navigate to ${JSON.stringify(url)}`
      let expired = false
      let started = false
      const barrier = pageQueue.then(async () => {
        if (expired) return
        assertPageUsable()
        started = true
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
          const navigation = await send<{ errorText?: string, loaderId?: string }>("Page.navigate", { url })
          if (navigation.errorText) {
            throw browserProviderError("cdp", `${operation} (${navigation.errorText})`)
          }
          navigationLoaderId = navigation.loaderId
          if (navigationLoaderId && !loadedLoaderIds.has(navigationLoaderId)) await loaded
        }
        finally {
          stopLoad()
        }
      })
      pageQueue = barrier.catch(() => {})
      await withTimeout(barrier, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, operation, (error) => {
        expired = true
        if (started) invalidatePage(error)
      })
    },
    locator(selector: string, options: BrowserLocatorOptions = {}) {
      return new CDPBrowserLocator(send, { selector, ...options }, clickLocator, assertPageUsable, invalidatePage)
    },
    async press(key) {
      assertPageUsable()
      await withTimeout((async () => {
        await send("Input.dispatchKeyEvent", { key, text: [...key].length === 1 ? key : undefined, type: "keyDown" })
        await send("Input.dispatchKeyEvent", { key, type: "keyUp" })
      })(), DEFAULT_TIMEOUT_MS, `press Browser key ${JSON.stringify(key)}`, invalidatePage)
    },
  }

  return { page, send }
}
