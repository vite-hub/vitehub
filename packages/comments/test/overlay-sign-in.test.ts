// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest"

import { api } from "../src/overlay/api.ts"

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
  await import("../src/overlay/index.ts")
  let overlay = document.querySelector("vitehub-comments")
  if (!overlay) {
    overlay = document.createElement("vitehub-comments")
    document.body.append(overlay)
  }
  await Promise.resolve()
  return overlay
}

it("quietly removes a denied overlay opened by the hint cookie alone", async () => {
  const overlay = await open("")
  expect(overlay.isConnected).toBe(false)
})

it("offers GitHub sign-in when the person explicitly requests Comments", async () => {
  const overlay = await open("?comments")
  expect(overlay.isConnected).toBe(true)
  const link = overlay.shadowRoot?.querySelector("a")
  expect(link?.textContent).toBe("Sign in with GitHub")
  expect(link?.getAttribute("href")).toBe(`${denied.signIn!.url}?return=${encodeURIComponent("/page?comments")}`)
})
