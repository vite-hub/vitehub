import { expect, it } from "vitest"

import { createWorkspaceHistoryReader } from "../src/core/history.ts"

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
