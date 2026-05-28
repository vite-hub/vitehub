import { describe, expect, it } from "vitest"

import { collectViteHubCliNamespaces } from "../src/cli.ts"

describe("CLI primitives", () => {
  it("collects package-contributed command namespaces", async () => {
    const namespaces = await collectViteHubCliNamespaces([
      {
        name: "@vitehub/agent/vite",
        vitehub: {
          cli: {
            namespaces: [{
              features: [{ name: "eval", run: () => undefined }],
              name: "agent",
            }],
          },
        },
      },
    ])

    expect(namespaces).toEqual([
      expect.objectContaining({
        features: [expect.objectContaining({ name: "eval" })],
        name: "agent",
      }),
    ])
  })

  it("merges features for the same namespace", async () => {
    const namespaces = await collectViteHubCliNamespaces([
      {
        vitehub: {
          cli: {
            namespaces: [{ features: [{ name: "eval", run: () => undefined }], name: "agent" }],
          },
        },
      },
      {
        vitehub: {
          cli: () => ({
            namespaces: [{ features: [{ name: "doctor", run: () => undefined }], name: "agent" }],
          }),
        },
      },
    ])

    expect(namespaces).toHaveLength(1)
    expect(namespaces[0]?.features.map(feature => feature.name)).toEqual(["eval", "doctor"])
  })
})
