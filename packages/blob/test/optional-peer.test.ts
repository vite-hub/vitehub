import { readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

import { importOptionalPeer } from "../src/internal/optional-peer.ts"

describe("optional peer imports", () => {
  it("explains how to install a missing adapter peer", async () => {
    await expect(importOptionalPeer("__vitehub_missing_peer__", "s3", "files-sdk"))
      .rejects.toThrow("The \"s3\" blob driver requires files-sdk. Install it with: pnpm add files-sdk")
  })

  it("keeps the generic Vercel Blob driver behind the lazy optional-peer path", async () => {
    const built = await readFile(new URL("../dist/drivers/vercel.js", import.meta.url), "utf8")

    expect(built).not.toContain('from "files-sdk/vercel-blob"')
    expect(built).not.toContain('from "@vercel/blob"')
  })

  it("keeps the bundled Vercel Blob driver statically reachable for selected Vercel outputs", async () => {
    const built = await readFile(new URL("../dist/drivers/vercel-bundled.js", import.meta.url), "utf8")

    expect(built).not.toContain('from "files-sdk"')
    expect(built).not.toContain('from "files-sdk/vercel-blob"')
    expect(built).toContain('from "@vercel/blob"')
  })

  it("keeps the Cloudflare-native R2 driver free of HTTP fallback peers", async () => {
    const built = await readFile(new URL("../dist/drivers/cloudflare-native.js", import.meta.url), "utf8")

    expect(built).not.toContain("files-sdk")
    expect(built).not.toContain("@aws-sdk/")
  })
})
