// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest"

import { api } from "../src/overlay/api.ts"
import start from "../src/overlay/index.ts"

import type { CommentsSession } from "../src/overlay/api.ts"

vi.mock("@vite-hub/realtime/client", () => ({ connectRealtimeRoom: vi.fn() }))

const denied: CommentsSession = {
  user: null,
  can: { read: false, comment: false, resolve: false },
  signIn: { provider: "github", url: "/api/_vitehub/comments/auth/github" },
  realtime: false,
  content: false,
}

afterEach(() => {
  document.querySelector("vitehub-comments")?.remove()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

async function open(search: string, session = denied) {
  history.replaceState(null, "", `/page${search}`)
  vi.spyOn(api, "session").mockResolvedValue([undefined, session])
  const pill = document.createElement("vitehub-pill")
  const bar = document.createElement("vitehub-tool")
  bar.slot = "comments"
  pill.append(bar)
  document.body.append(pill)
  start({
    bar, tool: { id: "comments", label: "Comments", icon: "", script: "/overlay.js" },
    signal: new AbortController().signal, open: true, exit: vi.fn(),
    createWindow: () => { throw new Error("Unexpected retained window") },
    openTool: vi.fn(async () => false), onOpen: vi.fn(), beforeExit: vi.fn(),
  })
  const overlay = document.querySelector("vitehub-comments")!
  await Promise.resolve()
  return overlay
}

it("keeps the sign-in prompt available when the shared session allowed the tool through the hint cookie", async () => {
  const overlay = await open("")
  expect(overlay.shadowRoot?.querySelector("a")?.textContent).toBe("Sign in with GitHub")
})

it("offers GitHub sign-in when the person explicitly requests Comments", async () => {
  const overlay = await open("?vitehub=comments")
  expect(overlay.isConnected).toBe(true)
  const link = overlay.shadowRoot?.querySelector("a")
  expect(link?.textContent).toBe("Sign in with GitHub")
  expect(link?.getAttribute("href")).toBe(`${denied.signIn!.url}?return=${encodeURIComponent("/page?vitehub=comments")}`)
})

it("offers account switching while keeping the denied segment hidden", async () => {
  const overlay = await open("", {
    ...denied,
    github: { login: "ada", repository: "vite-hub/vitehub", write: false },
    signOut: "/api/_vitehub/comments/auth/sign-out",
  })
  expect(overlay.shadowRoot?.textContent).toContain("@ada cannot push to vite-hub/vitehub")
  expect(overlay.shadowRoot?.querySelector("button")?.textContent).toBe("Use another account")
  expect(document.querySelector<HTMLElement>("vitehub-tool")?.hidden).toBe(true)
})

it("renders GitHub sign-out in the pill segment with no separate exit", async () => {
  vi.spyOn(api, "threads").mockResolvedValue([undefined, []])
  const overlay = await open("", {
    ...denied,
    user: { id: "ada", name: "Ada" },
    can: { read: true, comment: true, resolve: false },
    github: { login: "ada", repository: "vite-hub/vitehub", write: true },
    signOut: "/api/_vitehub/comments/auth/sign-out",
  })
  const bar = document.querySelector<HTMLElement>("vitehub-tool")!
  expect(bar.hidden).toBe(false)
  expect(bar.shadowRoot?.querySelector('[aria-label="Sign out @ada"]')).not.toBeNull()
  expect(overlay.shadowRoot?.querySelector('[aria-label="Sign out @ada"]')).toBeNull()
  expect(bar.shadowRoot?.querySelector('[aria-label="Leave comment mode"]')).toBeNull()
})
