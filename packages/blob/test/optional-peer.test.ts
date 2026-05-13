import { describe, expect, it } from "vitest"

import { importOptionalPeer } from "../src/internal/optional-peer.ts"

describe("optional peer imports", () => {
  it("explains how to install a missing adapter peer", async () => {
    await expect(importOptionalPeer("__vitehub_missing_peer__", "s3", "files-sdk"))
      .rejects.toThrow("The \"s3\" blob driver requires files-sdk. Install it with: pnpm add files-sdk")
  })
})
