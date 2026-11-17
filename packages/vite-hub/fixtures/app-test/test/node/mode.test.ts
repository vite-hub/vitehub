import assert from "node:assert/strict"
import { test } from "node:test"

// @ts-expect-error The `app-mode` plugin of vite.config.ts serves this module.
import mode from "#app-mode"

test("resolves the app config in test mode, as Vitest does", () => {
  assert.equal(mode, "test")
})
