import { H3 } from "h3"
import { expect, vi } from "vitest"

import { createCommentsHandler } from "../src/runtime/handler.ts"
import { createComments } from "./harness.ts"

import type { CommentsHandlerOptions } from "../src/runtime/handler.ts"
import type { DefineCommentsOptions } from "../src/types.ts"

/** One request that the overlay sent, with the headers that the server read. */
export interface SentRequest {
  method: string
  path: string
  headers: Headers
  body: unknown
}

/**
 * The real Comments API, in memory, behind the page's `fetch`. The overlay talks to it as it does on a site, so a test
 * sees what the server stored.
 */
export async function serveComments(options: DefineCommentsOptions = {}, handler: Partial<Omit<CommentsHandlerOptions, "comments">> = {}) {
  const comments = await createComments(options)
  const app = new H3().all("/api/_vitehub/comments/**", createCommentsHandler({ comments, realtime: false, ...handler }))
  const requests: SentRequest[] = []
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input), location.href)
    const request = new Request(url, init)
    const body: unknown = init.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method: request.method, path: `${url.pathname}${url.search}`, headers: request.headers, body })
    return await app.fetch(request)
  })
  vi.stubGlobal("fetch", fetch)
  return { comments, requests, fetch }
}

/** A pill segment and the page tools context that the loader gives the Comments tool. */
export function pageTools(options: { open?: boolean } = {}) {
  const pill = document.createElement("vitehub-pill")
  const bar = document.createElement("vitehub-tool")
  bar.slot = "comments"
  pill.append(bar)
  document.documentElement.append(pill)
  let windowBody: HTMLElement | undefined
  const controller = new AbortController()
  const context = {
    tool: { id: "comments", label: "Comments", icon: "i-lucide-message-square-text", script: "/overlay.js" },
    bar,
    signal: controller.signal,
    open: options.open ?? false,
    exit: vi.fn(),
    onOpen: vi.fn(),
    beforeExit: vi.fn(),
    openTool: vi.fn(async () => false),
    createTab: vi.fn(() => document.createElement("vitehub-tab")),
    createWindow: vi.fn(() => {
      windowBody = document.createElement("div")
      document.body.append(windowBody)
      return { body: windowBody, show: vi.fn(), hide: vi.fn(), destroy: vi.fn() }
    }),
  }
  return {
    pill,
    bar,
    context,
    controller,
    /** The shadow root of the list in the pill's window. */
    panel: () => windowBody?.firstElementChild?.shadowRoot ?? undefined,
  }
}

export async function startOverlay(tools: ReturnType<typeof pageTools>) {
  const { default: start } = await import("../src/overlay/index.ts")
  const cleanup = start(tools.context)
  const overlay = document.querySelector<HTMLElement>("vitehub-comments")!
  return { overlay, shadow: overlay.shadowRoot!, cleanup }
}

/** The toolbar button of the pill segment with this title. */
export function tool(bar: HTMLElement, title: string): HTMLButtonElement | null {
  return bar.shadowRoot?.querySelector<HTMLButtonElement>(`button[title^="${title}"]`) ?? null
}

/** Types into a composer textarea the way a person does: the value, the caret, then `input`. Vue renders before the next key. */
export async function type(input: HTMLTextAreaElement | HTMLInputElement, text: string) {
  input.value = text
  input.setSelectionRange(text.length, text.length)
  input.dispatchEvent(new Event("input", { bubbles: true }))
  await new Promise(resolve => setTimeout(resolve, 0))
}

export function press(target: Element, key: string, init: KeyboardEventInit = {}) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, ...init }))
}

/** A click of the comment layer at a point of the page, as pointer down and up. */
export async function clickPage(shadow: ShadowRoot, x: number, y: number) {
  await vi.waitFor(() => expect(shadow.querySelector("[data-slot='comment-layer-overlay']"), "comment mode is on").not.toBeNull())
  const layer = shadow.querySelector<HTMLElement>("[data-slot='comment-layer-overlay']")
  layer!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true, button: 0, clientX: x, clientY: y }))
  layer!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, composed: true, button: 0, clientX: x, clientY: y }))
}
