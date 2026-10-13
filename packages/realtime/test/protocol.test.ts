import { expect, it } from "vitest"
import { decodeWorkspaceChange, encodeWorkspaceChange } from "../src/protocol.ts"

it.each(["git~1/config", "docs/git~1/config", "vitehu~1/config", "docs/.. /secret", "docs/.git./config"])("rejects Windows-equivalent protected path %s", path => {
  expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "create", path }))).toBeUndefined()
  expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "move", from: path, to: "docs/safe.md" }))).toBeUndefined()
  expect(decodeWorkspaceChange(encodeWorkspaceChange({ operation: "move", from: "docs/safe.md", to: path }))).toBeUndefined()
})

