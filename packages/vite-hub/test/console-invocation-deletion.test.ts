import { expect, it, vi } from "vitest"
import { createConsoleInvocationDeletion } from "../src/console/runtime/client/invocation-deletion.ts"

it.each([false, true])("clears the deleted route before refreshing and retains exclusion when refresh throws %s", async (fails) => {
  const deletion = createConsoleInvocationDeletion()
  let route: string | undefined = "deleted"
  let selected: string | undefined = route
  let invocations = [{ id: "deleted" }, { id: "next" }]
  const actions: string[] = []
  const operation = deletion.remove("deleted", {
    clearSelection() { selected = undefined; actions.push("clear") },
    async navigate() {
      actions.push("navigate")
      // Route/list synchronization must not revive a confirmed deletion.
      selected = route && !deletion.has(route) ? route : undefined
      expect(selected).toBeUndefined()
      expect(invocations[0]?.id).toBe("deleted")
      route = undefined
    },
    removeFromList() { actions.push("remove"); invocations = [...deletion.exclude(invocations)] },
    async refresh() {
      actions.push("refresh")
      expect(route).toBeUndefined()
      expect(invocations).toEqual([{ id: "next" }])
      invocations = [{ id: "deleted" }, { id: "next" }]
      if (fails) throw new Error("refresh failed")
    },
  })
  if (fails) await expect(operation).rejects.toThrow("refresh failed")
  else await operation
  expect(actions).toEqual(["clear", "navigate", "remove", "refresh", "remove"])
  expect(selected).toBeUndefined()
  expect(route).toBeUndefined()
  expect(invocations).toEqual([{ id: "next" }])
})

it("keeps a deletion excluded if route navigation is interrupted", async () => {
  const deletion = createConsoleInvocationDeletion()
  const removeFromList = vi.fn()
  const refresh = vi.fn(async () => {})
  await expect(deletion.remove("deleted", {
    clearSelection() {},
    navigate: async () => { throw new Error("navigation interrupted") },
    removeFromList,
    refresh,
  })).rejects.toThrow("navigation interrupted")
  expect(deletion.has("deleted")).toBe(true)
  expect(removeFromList).toHaveBeenCalledTimes(2)
  expect(refresh).toHaveBeenCalledOnce()
})
