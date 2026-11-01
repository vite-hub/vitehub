import { createRenderer, ssrContextKey } from "vue"
import { describe, expect, it, vi } from "vitest"

vi.mock("../src/console/runtime/client/auth-management", () => ({ authDuration: () => "1 hour", changeAuthConsole: vi.fn() }))
import Action from "../src/console/runtime/components/console-auth-action.vue"

const renderer = createRenderer({
  createComment: () => ({}), createElement: () => ({}), createText: () => ({}),
  insert() {}, nextSibling: () => null, parentNode: () => null,
  patchProp() {}, remove() {}, setElementText() {}, setText() {},
})

interface Copy { title: string; description: string; submit: string; pending: string }

function copyOf(props: Record<string, unknown>): { copy: Copy; destructive: boolean } {
  const app = renderer.createApp({ ...Action, render: () => null }, { base: "/manage", ...props })
  app.provide(ssrContextKey, {})
  const instance = app.mount({})
  const state = (instance.$ as unknown as { setupState: { copy: Copy; destructive: boolean } }).setupState
  const result = { copy: { ...state.copy }, destructive: state.destructive }
  app.unmount()
  return result
}

describe("Auth action dialog copy", () => {
  it("asks before a destructive action and says what happens to the named user", () => {
    expect(copyOf({ action: "ban", userId: "u1", name: "ada@example.com" })).toEqual({
      copy: { title: "Ban this user?", description: "ada@example.com can no longer sign in, and every session ends.", submit: "Ban user", pending: "Banning…" },
      destructive: true,
    })
    expect(copyOf({ action: "revokeSessions", userId: "u1", name: "ada@example.com" }).copy.description).toBe("Every session of ada@example.com ends, and they must sign in again.")
    expect(copyOf({ action: "remove", userId: "u1", name: "ada@example.com" }).copy.description).toContain("This cannot be undone.")
  })

  it("names the user when no name is passed", () => {
    expect(copyOf({ action: "revokeSession", id: "s1" }).copy.description).toBe("The session ends, and the user must sign in again on that device.")
    expect(copyOf({ action: "unban", userId: "u1" }).copy.description).toBe("The user can sign in again.")
  })

  it("saves an edit instead of repeating the dialog title on the button", () => {
    const { copy, destructive } = copyOf({ action: "editField", userId: "u1", name: "ada@example.com", field: { key: "plan", label: "Plan", type: "string", required: false } })
    expect(copy).toMatchObject({ title: "Edit Plan", submit: "Save", pending: "Saving…" })
    expect(destructive).toBe(false)
  })
})
