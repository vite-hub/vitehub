import { cdp } from "../controllers/cdp.ts"
import { browserProviderError } from "../errors.ts"
import { attachCDPPage } from "./cdp-page.ts"

import type { BrowserAction } from "../types.ts"

interface KitesurfBrowserBinding {
  fetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response>
}

export async function runKitesurfAction(
  binding: KitesurfBrowserBinding,
  action: BrowserAction,
  input: Record<string, unknown>,
): Promise<Response> {
  if (action !== "content" && action !== "screenshot") {
    throw browserProviderError(
      "cloudflare",
      `run ${action} with Kitesurf; use engine "chromium" for this action`,
    )
  }

  const url = typeof input.url === "string" ? input.url : undefined
  const html = typeof input.html === "string" ? input.html : undefined
  if (Boolean(url) === Boolean(html)) {
    throw browserProviderError("cloudflare", `run ${action} with exactly one of "url" or "html"`)
  }

  const controller = cdp()
  const control = await controller.attach(
    { binding, engine: "kitesurf", kind: "cloudflare-binding" },
    {
      provider: {
        features: { liveHandoff: false },
        isolation: "provider",
        name: "cloudflare",
      },
      sessionId: "kitesurf",
    },
  )
  try {
    const { send } = await attachCDPPage(control.client)

    const viewport = input.viewport as { height?: unknown, width?: unknown } | undefined
    if (typeof viewport?.height === "number" && typeof viewport.width === "number") {
      await send("Emulation.setDeviceMetricsOverride", {
        deviceScaleFactor: 1,
        height: viewport.height,
        mobile: false,
        width: viewport.width,
      })
    }

    const frameTree = await send<{ frameTree?: { frame?: { id?: string } } }>("Page.getFrameTree")
    const frameId = frameTree.frameTree?.frame?.id
    if (!frameId) throw browserProviderError("cloudflare", "find the Kitesurf page frame")
    if (html) await send("Page.setDocumentContent", { frameId, html })
    else await send("Page.navigate", { url })
    await send("Runtime.evaluate", {
      awaitPromise: true,
      expression: 'document.readyState === "complete" ? true : new Promise(resolve => addEventListener("load", () => resolve(true), { once: true }))',
      returnByValue: true,
    })

    if (action === "content") {
      const result = await send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
        expression: "document.documentElement.outerHTML",
        returnByValue: true,
      })
      if (typeof result.result?.value !== "string") {
        throw browserProviderError("cloudflare", "read Kitesurf page content")
      }
      return new Response(result.result.value, {
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    }

    const options = input.screenshotOptions as Record<string, unknown> | undefined
    const type = options?.type === "jpeg" || options?.type === "webp" ? options.type : "png"
    let clip = options?.clip
    if (options?.fullPage) {
      const metrics = await send<{ result?: { value?: { height?: number, width?: number } } }>("Runtime.evaluate", {
        expression: "({ height: document.documentElement.scrollHeight, width: document.documentElement.scrollWidth })",
        returnByValue: true,
      })
      const size = metrics.result?.value
      if (!size?.height || !size.width) {
        throw browserProviderError("cloudflare", "measure the Kitesurf page")
      }
      clip = { height: size.height, scale: 1, width: size.width, x: 0, y: 0 }
    }
    if (options?.omitBackground) {
      await send("Emulation.setDefaultBackgroundColorOverride", {
        color: { a: 0, b: 0, g: 0, r: 0 },
      })
    }
    const screenshot = await send<{ data?: string }>("Page.captureScreenshot", {
      ...(clip ? { clip } : {}),
      captureBeyondViewport: options?.captureBeyondViewport !== false,
      format: type,
      fromSurface: options?.fromSurface !== false,
      ...(typeof options?.quality === "number" ? { quality: options.quality } : {}),
    })
    if (!screenshot.data) {
      throw browserProviderError("cloudflare", "capture the Kitesurf screenshot")
    }
    const bytes = Uint8Array.from(atob(screenshot.data), character => character.charCodeAt(0))
    return new Response(bytes, {
      headers: { "content-type": `image/${type}` },
    })
  }
  finally {
    await control.release()
  }
}
