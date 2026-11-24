import { toResponse } from "@vite-hub/runtime/internal/response"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  defineBrowser,
  executeBrowserDefinition,
  runBrowser,
} from "../src/runtime.ts"
import { loadCloudflarePlaywright as unconfiguredCloudflarePlaywright } from "../src/internal/runtime/unconfigured.ts"

import type { BrowserClient, BrowserDefinitionBrowser } from "../src/types.ts"

const runtimeConfig = vi.hoisted(() => ({ binding: "BROWSER", driver: "cloudflare" as string | undefined, engine: "chromium" }))
const availability = vi.hoisted(() => ({ available: true, host: "node", reason: "Browser is disabled.", fix: "Enable Browser on Cloudflare." }))
const browserRegistry = vi.hoisted(() => Object.create(null) as Record<string, unknown>)
vi.mock("#vitehub/browser/runtime", () => ({ default: runtimeConfig, loadCloudflarePlaywright: undefined }))
vi.mock("#vitehub/browser/availability", () => ({ default: availability }))
vi.mock("#vitehub/browser/registry", () => ({ default: browserRegistry }))

const runtime = globalThis as typeof globalThis & { __env__?: Record<string, unknown> }

afterEach(() => {
  delete runtime.__env__
  for (const key of Object.keys(browserRegistry)) delete browserRegistry[key]
  Object.setPrototypeOf(browserRegistry, null)
  runtimeConfig.driver = "cloudflare"
  availability.available = true
})

describe("Browser Definitions", () => {
  it("exports the optional driver loader from the unconfigured runtime fallback", () => {
    expect(unconfiguredCloudflarePlaywright).toBeUndefined()
  })

  it("reports an unconfigured runtime before opening a default binding", async () => {
    runtimeConfig.driver = undefined
    const definition = defineBrowser(async (_input, { browser }) => {
      await browser.open()
    })

    await expect(executeBrowserDefinition(definition, undefined)).rejects.toMatchObject({
      code: "BROWSER_UNAVAILABLE",
    })
  })

  it("returns BROWSER_DEFINITION_NOT_FOUND for an unknown name", async () => {
    const name: string = "missing"
    const [error, data] = await runBrowser(name)
    expect(data).toBeUndefined()
    expect(error).toMatchObject({ code: "BROWSER_DEFINITION_NOT_FOUND", status: 404 })
    expect(toResponse(error).status).toBe(404)
  })

  it("returns the handler value as data, and a handler failure as BROWSER_RUN_FAILED", async () => {
    const failure = new Error("page crashed")
    browserRegistry.title = { default: defineBrowser(async (input: { url: string }) => `title of ${input.url}`) }
    browserRegistry.broken = { default: defineBrowser(async () => { throw failure }) }

    const title: string = "title"
    const broken: string = "broken"
    expect(await runBrowser(title, { url: "https://example.com" })).toEqual([undefined, "title of https://example.com"])
    const [error] = await runBrowser(broken)
    expect(error).toMatchObject({ code: "BROWSER_RUN_FAILED", cause: failure })
    expect(toResponse(error).status).toBe(500)
  })

  it("throws BROWSER_UNAVAILABLE in a build without a Browser provider", async () => {
    availability.available = false
    runtimeConfig.driver = undefined

    const name: string = "page"
    await expect(runBrowser(name)).rejects.toMatchObject({
      code: "BROWSER_UNAVAILABLE",
      details: { host: "node", fix: availability.fix },
    })
  })

  it("returns BROWSER_RUN_FAILED when a Definition loader rejects", async () => {
    const cause = new Error("module initialization failed")
    browserRegistry.page = async () => { throw cause }

    const name: string = "page"
    const [error, data] = await runBrowser(name)
    expect(data).toBeUndefined()
    expect(error).toMatchObject({ code: "BROWSER_RUN_FAILED" })
    expect(error?.cause).toBe(cause)
    expect(toResponse(error).status).toBe(500)
  })

  it("does not treat inherited registry properties as Browser Definitions", async () => {
    Object.setPrototypeOf(browserRegistry, {
      inherited: { default: defineBrowser(() => "unexpected") },
    })

    const name: string = "inherited"
    const [error] = await runBrowser(name)

    expect(error).toMatchObject({ code: "BROWSER_DEFINITION_NOT_FOUND" })
  })

  it("rejects Browser Definitions whose run handler is inherited", async () => {
    browserRegistry.inheritedRun = async () => ({
      default: Object.create({ run: async () => "unexpected" }),
    })

    const name: string = "inheritedRun"

    await expect(runBrowser(name)).rejects.toMatchObject({
      code: "BROWSER_R0009",
      message: '[vitehub:browser] Browser Definition "inheritedRun" must default-export defineBrowser().',
    })
  })

  it("rejects Browser Definition loaders that resolve to null", async () => {
    browserRegistry.nullDefinition = async () => null

    const name: string = "nullDefinition"

    await expect(runBrowser(name)).rejects.toMatchObject({
      code: "BROWSER_R0009",
      message: '[vitehub:browser] Browser Definition "nullDefinition" must default-export defineBrowser().',
    })
  })

  it("lets definitions use rendered content", async () => {
    const quickAction = vi.fn(async () => new Response(
      "<html><meta property=\"og:image\" content=\"https://example.com/card.png\"></html>",
    ))
    runtime.__env__ = { BROWSER: { quickAction } }
    const definition = defineBrowser(async (input: { url: string }, { browser }) => {
      return await browser.content(input.url)
    })

    await expect(executeBrowserDefinition(definition, { url: "https://example.com" })).resolves.toContain("card.png")

    expect(quickAction).toHaveBeenCalledWith("content", { url: "https://example.com" })
  })

  it("runs generic browser actions without exposing the provider method", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/png" },
    })
    const quickAction = vi.fn(async () => response)
    runtime.__env__ = { BROWSER: { quickAction } }
    const definition = defineBrowser(async (input: { url: string }, { browser }) => {
      return await browser.run("screenshot", input)
    })

    await expect(executeBrowserDefinition(definition, { url: "https://example.com" })).resolves.toBe(response)

    expect(quickAction).toHaveBeenCalledWith("screenshot", { url: "https://example.com" })
  })

  it("bounds stalled Browser Definition quick actions", async () => {
    vi.useFakeTimers()
    try {
      runtime.__env__ = { BROWSER: { quickAction: async () => await new Promise(() => {}) } }
      const definition = defineBrowser(async (input: { url: string }, { browser }) => {
        return await browser.content(input.url)
      })

      const invocation = executeBrowserDefinition(definition, { url: "https://example.com" })
      const result = expect(invocation).rejects.toThrow("Browser content request failed with status 500")
      await vi.advanceTimersByTimeAsync(30_000)

      await result
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("closes definition-owned page sessions", async () => {
    const release = vi.fn(async () => {})
    const close = vi.fn(async () => {})
    const client = {
      open: vi.fn(async () => ({
        id: "browser-1",
        attach: vi.fn(async () => ({
          client: {
            on: vi.fn(() => () => {}),
            send: vi.fn(async (method: string) => method === "Target.getTargets"
              ? { targetInfos: [{ targetId: "page", type: "page" }] }
              : method === "Target.attachToTarget" ? { sessionId: "page-1" } : {}),
          },
          release,
        })),
        close,
        inspect: vi.fn(() => ({ features: { liveHandoff: false }, id: "browser-1", provider: "test", state: "released" })),
      })),
    } as unknown as BrowserClient
    const definition = defineBrowser(async (_input, { browser }) => {
      await browser.open()
      return "ok"
    })

    await expect(executeBrowserDefinition(definition, undefined, { client })).resolves.toBe("ok")
    expect(release).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it("shares concurrent definition-owned page session cleanup", async () => {
    let finishRelease!: () => void
    const release = vi.fn(async () => await new Promise<void>(resolve => {
      finishRelease = resolve
    }))
    const close = vi.fn(async () => {})
    const client = {
      open: vi.fn(async () => ({
        id: "browser-1",
        attach: vi.fn(async () => ({
          client: {
            on: vi.fn(() => () => {}),
            send: vi.fn(async (method: string) => method === "Target.getTargets"
              ? { targetInfos: [{ targetId: "page", type: "page" }] }
              : method === "Target.attachToTarget" ? { sessionId: "page-1" } : {}),
          },
          release,
        })),
        close,
        inspect: vi.fn(),
      })),
    } as unknown as BrowserClient
    const definition = defineBrowser(async (_input, { browser }) => {
      const pageSession = await browser.open()
      const first = pageSession.close()
      const second = pageSession.close()
      expect(release).toHaveBeenCalledOnce()
      expect(close).not.toHaveBeenCalled()
      finishRelease()
      await Promise.all([first, second])
    })

    await executeBrowserDefinition(definition, undefined, { client })
    expect(release).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it("bounds stalled controller release during definition cleanup", async () => {
    vi.useFakeTimers()
    try {
      const close = vi.fn(async () => {})
      const client = {
        open: vi.fn(async () => ({
          id: "browser-1",
          attach: vi.fn(async () => ({
            client: {
              on: vi.fn(() => () => {}),
              send: vi.fn(async (method: string) => method === "Target.getTargets"
                ? { targetInfos: [{ targetId: "page", type: "page" }] }
                : method === "Target.attachToTarget" ? { sessionId: "page-1" } : {}),
            },
            release: vi.fn(async () => await new Promise(() => {})),
          })),
          close,
          inspect: vi.fn(),
        })),
      } as unknown as BrowserClient
      const definition = defineBrowser(async (_input, { browser }) => {
        await browser.open()
      })

      const invocation = executeBrowserDefinition(definition, undefined, { client })
      const result = expect(invocation).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })
      await vi.advanceTimersByTimeAsync(30_000)

      await result
      expect(close).toHaveBeenCalledOnce()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("bounds stalled provider closure during definition cleanup", async () => {
    vi.useFakeTimers()
    try {
      const close = vi.fn(async () => await new Promise<void>(() => {}))
      const client = {
        open: vi.fn(async () => ({
          id: "browser-1",
          attach: vi.fn(async () => ({
            client: {
              on: vi.fn(() => () => {}),
              send: vi.fn(async (method: string) => method === "Target.getTargets"
                ? { targetInfos: [{ targetId: "page", type: "page" }] }
                : method === "Target.attachToTarget" ? { sessionId: "page-1" } : {}),
            },
            release: vi.fn(async () => {}),
          })),
          close,
          inspect: vi.fn(),
        })),
      } as unknown as BrowserClient
      const definition = defineBrowser(async (_input, { browser }) => {
        await browser.open()
      })

      const invocation = executeBrowserDefinition(definition, undefined, { client })
      const result = expect(invocation).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })
      await vi.advanceTimersByTimeAsync(30_000)

      await result
      expect(close).toHaveBeenCalledOnce()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("bounds stalled controller attachment and closes the provider session", async () => {
    vi.useFakeTimers()
    try {
      const close = vi.fn(async () => {})
      const client = {
        open: vi.fn(async () => ({
          id: "browser-1",
          attach: vi.fn(async () => await new Promise(() => {})),
          close,
          inspect: vi.fn(() => ({ features: { liveHandoff: false }, id: "browser-1", provider: "test", state: "released" })),
        })),
      } as unknown as BrowserClient
      const definition = defineBrowser(async (_input, { browser }) => {
        await browser.open()
      })

      const invocation = executeBrowserDefinition(definition, undefined, { client })
      const result = expect(invocation).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })
      await vi.advanceTimersByTimeAsync(30_000)

      await result
      expect(close).toHaveBeenCalledOnce()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("bounds stalled cleanup after controller attachment times out", async () => {
    vi.useFakeTimers()
    try {
      const client = {
        open: vi.fn(async () => ({
          id: "browser-1",
          attach: vi.fn(async () => await new Promise(() => {})),
          close: vi.fn(async () => await new Promise(() => {})),
          inspect: vi.fn(() => ({ features: { liveHandoff: false }, id: "browser-1", provider: "test", state: "released" })),
        })),
      } as unknown as BrowserClient
      const definition = defineBrowser(async (_input, { browser }) => {
        await browser.open()
      })

      const invocation = executeBrowserDefinition(definition, undefined, { client })
      const result = expect(invocation).rejects.toBeInstanceOf(AggregateError)
      await vi.advanceTimersByTimeAsync(60_000)

      await result
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("continues to provider cleanup when controller release stalls", async () => {
    vi.useFakeTimers()
    try {
      const close = vi.fn(async () => {})
      const client = {
        open: vi.fn(async () => ({
          id: "browser-1",
          attach: vi.fn(async () => ({
            client: { on: vi.fn(() => () => {}), send: vi.fn(async () => ({ targetInfos: [] })) },
            release: vi.fn(async () => await new Promise(() => {})),
          })),
          close,
          inspect: vi.fn(() => ({ features: { liveHandoff: false }, id: "browser-1", provider: "test", state: "released" })),
        })),
      } as unknown as BrowserClient
      const definition = defineBrowser(async (_input, { browser }) => {
        await browser.open()
      })

      const invocation = executeBrowserDefinition(definition, undefined, { client })
      const result = expect(invocation).rejects.toBeInstanceOf(AggregateError)
      await vi.advanceTimersByTimeAsync(30_000)

      await result
      expect(close).toHaveBeenCalledOnce()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("releases the controller before closing a session when page setup fails", async () => {
    const release = vi.fn(async () => {})
    const close = vi.fn(async () => {})
    const client = {
      open: vi.fn(async () => ({
        id: "browser-1",
        attach: vi.fn(async () => ({
          client: {
            on: vi.fn(() => () => {}),
            send: vi.fn(async () => ({ targetInfos: [] })),
          },
          release,
        })),
        close,
        inspect: vi.fn(),
      })),
    } as unknown as BrowserClient
    const definition = defineBrowser(async (_input, { browser }) => {
      await browser.open()
    })

    await expect(executeBrowserDefinition(definition, undefined, { client })).rejects.toMatchObject({
      code: "BROWSER_PROVIDER_ERROR",
    })
    expect(release).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]!)
  })

  it("closes a page session that finishes opening after another open fails", async () => {
    let finishAttach!: () => void
    const attached = new Promise<void>(resolve => {
      finishAttach = resolve
    })
    const release = vi.fn(async () => {})
    const close = vi.fn(async () => {})
    const client = {
      open: vi.fn()
        .mockImplementationOnce(async () => ({
          id: "browser-1",
          attach: vi.fn(async () => {
            await attached
            return {
              client: {
                on: vi.fn(() => () => {}),
                send: vi.fn(async (method: string) => method === "Target.getTargets"
                  ? { targetInfos: [{ targetId: "page", type: "page" }] }
                  : method === "Target.attachToTarget" ? { sessionId: "page-1" } : {}),
              },
              release,
            }
          }),
          close,
          inspect: vi.fn(),
        }))
        .mockImplementationOnce(async () => {
          throw new Error("too many browsers")
        }),
    } as unknown as BrowserClient
    const definition = defineBrowser(async (_input, { browser }) => {
      await Promise.all([browser.open(), browser.open()])
    })

    const invocation = executeBrowserDefinition(definition, undefined, { client })
    const settled = invocation.then(() => "resolved", () => "rejected")
    await new Promise(resolve => setTimeout(resolve, 0))
    finishAttach()
    expect(await settled).toBe("rejected")
    await expect(invocation).rejects.toThrow("too many browsers")
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(release).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it("returns the open error while another acquisition is pending, and closes that session when it arrives", async () => {
    let finishAcquire!: () => void
    const acquired = new Promise<void>(resolve => {
      finishAcquire = resolve
    })
    const attach = vi.fn()
    const close = vi.fn(async () => {})
    let laterOpen: Promise<unknown> | undefined
    const client = {
      open: vi.fn()
        .mockImplementationOnce(async () => {
          await acquired
          return { id: "browser-1", attach, close, inspect: vi.fn() }
        })
        .mockImplementationOnce(async () => {
          throw new Error("too many browsers")
        }),
    } as unknown as BrowserClient
    const definition = defineBrowser(async (_input, { browser }) => {
      laterOpen = browser.open().catch((error: unknown) => error)
      await browser.open()
    })

    await expect(executeBrowserDefinition(definition, undefined, { client })).rejects.toThrow("too many browsers")
    expect(close).not.toHaveBeenCalled()
    finishAcquire()
    await expect(laterOpen).resolves.toMatchObject({ code: "BROWSER_SESSION_STATE" })
    expect(attach).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it("rejects an open that starts after the Browser Definition ends", async () => {
    const client = { open: vi.fn() } as unknown as BrowserClient
    let ended: BrowserDefinitionBrowser | undefined
    await executeBrowserDefinition(defineBrowser(async (_input, { browser }) => {
      ended = browser
    }), undefined, { client })

    await expect(ended?.open()).rejects.toMatchObject({ code: "BROWSER_SESSION_STATE" })
    expect(client.open).not.toHaveBeenCalled()
  })

  it("does not retry session cleanup after a successful handler", async () => {
    const release = vi.fn(async () => {
      throw new Error("release failed")
    })
    const close = vi.fn(async () => {})
    const client = {
      open: vi.fn(async () => ({
        id: "browser-1",
        attach: vi.fn(async () => ({
          client: {
            on: vi.fn(() => () => {}),
            send: vi.fn(async (method: string) => method === "Target.getTargets"
              ? { targetInfos: [{ targetId: "page", type: "page" }] }
              : method === "Target.attachToTarget" ? { sessionId: "page-1" } : {}),
          },
          release,
        })),
        close,
        inspect: vi.fn(),
      })),
    } as unknown as BrowserClient
    const definition = defineBrowser(async (_input, { browser }) => {
      await browser.open()
      return "ok"
    })

    await expect(executeBrowserDefinition(definition, undefined, { client })).rejects.toThrow("release failed")
    expect(release).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })
})
