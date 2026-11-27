import { mergeConfig } from "vitest/config"

import { nodeAndTypeTests } from "../../vitest.shared.ts"

export default mergeConfig(nodeAndTypeTests, {
  test: { maxWorkers: 4, testTimeout: 30_000 },
})
