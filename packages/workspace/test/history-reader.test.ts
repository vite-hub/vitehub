import { expect, it, vi } from "vitest"

import { createWorkspaceHistoryReader } from "../src/core/history.ts"
import type { WorkspaceHistoryReader } from "../src/core/types.ts"

it.each([true, false])("constructs a reader without retained history (complete=%s)", async complete => {
  const reader = createWorkspaceHistoryReader(undefined, complete)

  expect(reader.digest).toBeUndefined()
  expect(reader.forksFrom).toBeUndefined()
  expect(reader.pullRequests).toBeUndefined()
  await expect(reader.head()).rejects.toThrow(/history/)
  await expect(reader.list()).rejects.toThrow(/history/)
  await expect(reader.refs()).rejects.toThrow(/history/)
  await expect(reader.open("revision")).rejects.toThrow(/history/)
  await expect(reader.usage()).rejects.toThrow(/history/)
})

it.each([true, false])("requires complete access before listing pull requests (complete=%s)", async complete => {
  const options = { headPrefix: "private/" }
  const requests = [{ number: 1, url: "https://github.com/owner/repo/pull/1", title: "Private change", head: "private/change", base: "main" }]
  const pullRequests = vi.fn(async () => requests)
  const history: WorkspaceHistoryReader = {
    head: async () => null,
    list: async () => ({ revisions: [] }),
    refs: async () => [],
    open: async () => { throw new Error("No revisions") },
    usage: async () => ({ bytes: 0, objects: 0 }),
    pullRequests,
  }
  const reader = createWorkspaceHistoryReader(history, complete)

  if (complete) {
    await expect(reader.pullRequests!(options)).resolves.toEqual(requests)
    expect(pullRequests).toHaveBeenCalledExactlyOnceWith(options)
  }
  else {
    await expect(reader.pullRequests!(options)).rejects.toMatchObject({ code: "WORKSPACE_R0069" })
    expect(pullRequests).not.toHaveBeenCalled()
  }
})
