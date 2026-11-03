import { expect, it } from "vitest"

import { installArguments } from "../src/internal/optional-owners.ts"

const sha = "52e6aba01356ffd6c5f1d0d6e8dafc3d63788b82"

it("names the matching pkg.pr.new preview of ViteHub packages when vite-hub is a preview", () => {
  // pnpm pack writes the version into the optional peers. Only the dependencies point at the preview.
  const manifest = {
    dependencies: { "@vite-hub/env": `https://pkg.pr.new/vite-hub/vitehub/@vite-hub/env@${sha}`, "h3": "^2.0.0" },
    peerDependencies: { "@vite-hub/database": "0.1.0" },
    version: "0.1.0",
  }
  expect(installArguments(["@vite-hub/database", "drizzle-orm"], manifest)).toEqual([
    `https://pkg.pr.new/vite-hub/vitehub/@vite-hub/database@${sha}`,
    "drizzle-orm",
  ])
})

it("keeps plain package names when vite-hub comes from npm", () => {
  const manifest = { dependencies: { "@vite-hub/env": "0.1.0" }, version: "0.1.0" }
  expect(installArguments(["@vite-hub/database", "drizzle-orm"], manifest)).toEqual(["@vite-hub/database", "drizzle-orm"])
})
