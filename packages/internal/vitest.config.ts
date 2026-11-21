import { fileURLToPath } from "node:url"
import { defineConfig, mergeConfig } from "vitest/config"

import { nodeAndTypeTests } from "../../vitest.shared.ts"

// The page pill takes the motion layer from the `@vite-hub/ui` sources, as the build of this package does.
export default mergeConfig(nodeAndTypeTests, defineConfig({
  resolve: { alias: { "@vite-hub/ui/motion/core": fileURLToPath(new URL("../ui/src/motion-core.ts", import.meta.url)) } },
}))
