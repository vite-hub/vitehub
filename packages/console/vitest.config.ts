import { defineConfig } from "vite-plus"

// Tests load the Console modules on their own, without the app's ViteHub and Nitro plugins.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
})
