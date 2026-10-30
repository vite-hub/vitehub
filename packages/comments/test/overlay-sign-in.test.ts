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
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

async function open(search: string) {
  history.replaceState(null, "", `/page${search}`)
  vi.spyOn(api, "session").mockResolvedValue([undefined, denied])
  start({ tool: { id: "comments", label: "Comments", icon: "", script: "/overlay.js" }, signal: new AbortController().signal, open: true, exit: vi.fn() })
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
