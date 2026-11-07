import { describe, expect, it } from "vitest"

import { lineageDigest, readDerivedFrom, staleDerivedFiles } from "../src/lineage.ts"

const encode = (text: string) => new TextEncoder().encode(text)
const english = encode("---\ntitle: Guide\n---\n\nInstall it.\n")
const digest = lineageDigest(english)

describe("lineage", () => {
  it("reads derivedFrom from Markdown frontmatter, YAML, and JSON", () => {
    expect(readDerivedFrom("docs/es/guide.md", encode(`---\ntitle: Guía\nderivedFrom:\n  path: docs/en/guide.md\n  digest: "${digest}"\n---\n\nInstálalo.\n`))).toEqual({ digest, path: "docs/en/guide.md" })
    expect(readDerivedFrom("docs/es/guide.md", encode(`---\nderivedFrom: { path: 'docs/en/guide.md', digest: ${digest} }\n---\n`))).toEqual({ digest, path: "docs/en/guide.md" })
    expect(readDerivedFrom("data/es.yaml", encode(`derivedFrom: { path: data/en.yaml, digest: ${digest} }\nname: Hola\n`))).toEqual({ digest, path: "data/en.yaml" })
    expect(readDerivedFrom("data/es.json", encode(JSON.stringify({ derivedFrom: { digest, path: "data/en.json" }, name: "Hola" })))).toEqual({ digest, path: "data/en.json" })
  })

  it("ignores files without derivedFrom, an incomplete one, a body line, and binary files", () => {
    expect(readDerivedFrom("docs/en/guide.md", english)).toBeUndefined()
    expect(readDerivedFrom("docs/es/guide.md", encode("---\nderivedFrom:\n  path: docs/en/guide.md\n---\n"))).toBeUndefined()
    expect(readDerivedFrom("docs/es/guide.md", encode(`# Guía\n\nderivedFrom: { path: docs/en/guide.md, digest: ${digest} }\n`))).toBeUndefined()
    expect(readDerivedFrom("data/es.json", encode("{ not json"))).toBeUndefined()
    expect(readDerivedFrom("media/logo.png", new Uint8Array([0, 255, 254]))).toBeUndefined()
  })

  it("lists derived files whose source changed or is gone, with the digest of the source now", () => {
    const changed = encode("---\ntitle: Guide\n---\n\nInstall it with pnpm.\n")
    const derived = (source: string, sourceDigest: string) => encode(`---\nderivedFrom: { path: ${source}, digest: ${sourceDigest} }\n---\n`)
    const files = new Map([
      ["docs/en/guide.md", changed],
      ["docs/en/intro.md", english],
      ["docs/es/guide.md", derived("docs/en/guide.md", digest)],
      ["docs/es/intro.md", derived("docs/en/intro.md", digest)],
      ["docs/es/old.md", derived("docs/en/old.md", digest)],
    ])

    expect(staleDerivedFiles(files)).toEqual([
      { derivedFrom: { digest, path: "docs/en/guide.md" }, path: "docs/es/guide.md", reason: "changed", sourceDigest: lineageDigest(changed) },
      { derivedFrom: { digest, path: "docs/en/old.md" }, path: "docs/es/old.md", reason: "missing" },
    ])
  })
})
