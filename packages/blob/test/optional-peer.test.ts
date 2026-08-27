import { readFile } from "node:fs/promises"

import { describe, expect, it } from "vitest"

import { filesSdkDriverPeers, getFilesSdkPeerInstall } from "../src/internal/files-sdk-peers.ts"
import { importOptionalPeer } from "../src/internal/optional-peer.ts"

async function readLocalClosure(entry: URL, seen = new Set<string>()): Promise<string[]> {
  if (seen.has(entry.href)) return []
  seen.add(entry.href)

  const source = await readFile(entry, "utf8")
  const imports = [...source.matchAll(/(?:from\s+|import\s*\()["'](\.\.?\/[^"']+)["']/g)]
  const children = await Promise.all(imports.map(match => readLocalClosure(new URL(match[1]!, entry), seen)))
  return [source, ...children.flat()]
}

describe("optional peer imports", () => {
  it("explains how to install a missing adapter peer", async () => {
    const missingPeer = Object.assign(new Error("missing"), { code: "ERR_MODULE_NOT_FOUND" })
    await expect(importOptionalPeer(() => Promise.reject(missingPeer), "__vitehub_missing_peer__", "s3", "files-sdk"))
      .rejects.toThrow("The \"s3\" blob driver requires files-sdk. Install it with: pnpm add files-sdk")
  })

  it("names the provider peers required by bundled Files SDK adapters", async () => {
    expect(getFilesSdkPeerInstall("azure")).toBe("@azure/identity @azure/storage-blob")
    expect(getFilesSdkPeerInstall("google-drive")).toBe("@googleapis/drive google-auth-library")
    expect(getFilesSdkPeerInstall("cloudflare-r2")).toContain("@aws-sdk/client-s3")

    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      peerDependencies: Record<string, string>
      peerDependenciesMeta: Record<string, { optional?: boolean }>
    }
    const providerPeers = new Set(Object.values(filesSdkDriverPeers).flat())
    for (const peer of providerPeers) {
      expect(manifest.peerDependencies).toHaveProperty(peer)
      expect(manifest.peerDependenciesMeta[peer]?.optional).toBe(true)
    }
  })

  it("uses caller-owned imports so package builds can bundle each selected peer", async () => {
    const source = await readFile(new URL("../src/internal/optional-peer.ts", import.meta.url), "utf8")

    expect(source).toContain("return await load()")
    expect(source).not.toContain("node:module")
  })

  it("patches Vercel stream byte ownership and cancellation", async () => {
    const closure = (await readLocalClosure(new URL(import.meta.resolve("@vercel/blob")))).join("\n")

    expect(closure).toContain("new Uint8Array(result.value)")
    expect(closure).toContain("value.destroy(reason)")
    expect(closure).not.toContain("reason instanceof Error ? reason : void 0")
  })

  it("ships the patched Vercel Blob runtime through the public driver", async () => {
    const built = await readFile(new URL("../dist/drivers/vercel.js", import.meta.url), "utf8")

    expect(built).not.toContain('from "files-sdk/vercel-blob"')
    expect(built).toContain("vercel-bundled")
  })

  it("keeps the bundled Vercel Blob driver statically reachable for selected Vercel outputs", async () => {
    const closure = (await readLocalClosure(new URL("../dist/drivers/vercel-bundled.js", import.meta.url))).join("\n")

    expect(closure).not.toContain('from "files-sdk"')
    expect(closure).not.toContain('from "files-sdk/vercel-blob"')
    expect(closure).not.toContain('from "@vercel/blob"')
    expect(closure).not.toContain('from "undici"')
    expect(closure).not.toContain('from "stream"')
    expect(closure).not.toContain('from "node:module"')
    expect(closure).toContain("globalThis.fetch")
    expect(closure).toContain("vercel-storage.com")
  })

  it("ships the generic Files SDK runtime through the public driver", async () => {
    const closure = (await readLocalClosure(new URL("../dist/drivers/files.js", import.meta.url))).join("\n")

    expect(closure).not.toContain('from "files-sdk')
    expect(closure).not.toContain('import("files-sdk')
    expect(closure).not.toContain('from "node:module"')
  })

  it("keeps the Netlify driver closure free of Node module loading", async () => {
    const closure = (await readLocalClosure(new URL("../dist/drivers/netlify-blobs.js", import.meta.url))).join("\n")

    expect(closure).not.toContain('from "node:module"')
  })

  it("keeps the Cloudflare-native R2 driver free of HTTP fallback peers", async () => {
    const built = await readFile(new URL("../dist/drivers/cloudflare-native.js", import.meta.url), "utf8")

    expect(built).not.toContain("files-sdk")
    expect(built).not.toContain("@aws-sdk/")
  })
})

describe("package exports", () => {
  it("keeps the Files SDK helper private to the bundled drivers", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      exports: Record<string, string>
    }

    expect(manifest.exports).not.toHaveProperty("./drivers/files-sdk")
  })

  it("keeps the bundled Vercel runtime internal", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      exports: Record<string, string>
    }

    expect(manifest.exports).toHaveProperty("./drivers/vercel")
    expect(manifest.exports).not.toHaveProperty("./drivers/vercel-bundled")
  })

  it("routes provider-specific Files SDK exports through their bundled runtimes", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      exports: Record<string, string | { types: string, default: string }>
    }
    const providers = [
      "akamai",
      "azure",
      "box",
      "digitalocean-spaces",
      "dropbox",
      "fs",
      "gcs",
      "google-drive",
      "hetzner",
      "minio",
      "onedrive",
      "s3",
      "storj",
      "supabase",
      "uploadthing",
    ]

    for (const provider of providers) {
      expect(manifest.exports[`./drivers/${provider}`]).toEqual({
        types: `./dist/drivers/${provider}.d.ts`,
        default: `./dist/drivers/${provider}.js`,
      })
    }
  })
})
