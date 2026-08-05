import { readFile, readdir } from "node:fs/promises"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

const docsRoot = resolve(import.meta.dirname, "..")
const fixturesRoot = resolve(import.meta.dirname, "../../fixtures/tutorials")

function normalize(source: string) {
  return source.trim().replaceAll("\r\n", "\n")
}

function codeBlocks(source: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp("```[^\\n]*\\[" + escaped + "\\]\\n([\\s\\S]*?)\\n```", "g")

  return [...source.matchAll(pattern)].map(match => normalize(match[1] || ""))
}

async function expectPageToUseFixture(pagePath: string, fixture: string, labels: string[]) {
  const page = await readFile(resolve(docsRoot, pagePath), "utf8")

  for (const label of labels) {
    const expected = normalize(await readFile(resolve(fixturesRoot, fixture, label), "utf8"))
    expect(codeBlocks(page, label), `${pagePath} should include ${label}`).toContain(expected)
  }
}

describe("launch tutorials", () => {
  it("uses the framework distribution as the only direct ViteHub dependency", async () => {
    for (const fixture of ["agents", "server-primitives"]) {
      const manifest = JSON.parse(await readFile(resolve(fixturesRoot, fixture, "package.json"), "utf8"))
      const dependencyNames = Object.keys(manifest.dependencies || {})

      expect(dependencyNames).toContain("vite-hub")
      expect(dependencyNames.filter(name => name.startsWith("@vite-hub/"))).toEqual([])
    }
  })

  it("keeps every source file in the cold-rendered tutorial body", async () => {
    const pages = [
      {
        fixture: "server-primitives",
        labels: ["vite.config.ts", "src/server.ts"],
        path: "content/blog/1.server-primitives.md",
      },
      {
        fixture: "agents",
        labels: ["vite.config.ts", "server/agents/greeting.ts", "src/memo.ts", "src/server.ts"],
        path: "content/blog/2.agents.md",
      },
    ]

    for (const page of pages) {
      const source = await readFile(resolve(docsRoot, page.path), "utf8")
      expect(source).not.toContain("::code-tree-intersection")

      for (const label of page.labels) {
        const expected = normalize(await readFile(resolve(fixturesRoot, page.fixture, label), "utf8"))
        expect(codeBlocks(source, label), `${page.path} should render ${label} inline`).toContain(expected)
      }
    }
  })

  it("publishes exactly two tutorial entries without eval sections", async () => {
    const blogRoot = resolve(docsRoot, "content/blog")
    const entries = (await readdir(blogRoot)).filter(file => file.endsWith(".md")).sort()

    expect(entries).toEqual([
      "1.server-primitives.md",
      "2.agents.md",
    ])

    for (const entry of entries) {
      const source = await readFile(resolve(blogRoot, entry), "utf8")
      expect(source).toContain("layout: tutorial")
      expect(source).not.toMatch(/^##?\s+Evals?\b/im)
    }
  })

  it("keeps the Server Primitives quickstart on the checked fixture", async () => {
    const labels = ["vite.config.ts", "src/server.ts"]

    await expectPageToUseFixture("content/docs/getting-started/first-server-primitive.md", "server-primitives", labels)
  })

  it("keeps the Agents quickstart on the checked fixture", async () => {
    const labels = ["vite.config.ts", "server/agents/greeting.ts", "src/server.ts"]

    await expectPageToUseFixture("content/docs/getting-started/first-agent.md", "first-agent", labels)
  })

  it("loads the model upgrade credential when restarting the Agents tutorial", async () => {
    const source = await readFile(resolve(docsRoot, "content/blog/2.agents.md"), "utf8")

    expect(source).toContain("node --env-file=.env dist/server.js")
  })

  it("initializes every standalone tutorial as an ESM package", async () => {
    const pages = [
      "content/blog/1.server-primitives.md",
      "content/blog/2.agents.md",
      "content/docs/getting-started/first-server-primitive.md",
      "content/docs/getting-started/first-agent.md",
    ]

    for (const page of pages) {
      const source = await readFile(resolve(docsRoot, page), "utf8")
      expect(source, `${page} should configure Node.js to load the built server as ESM`).toContain(
        "pnpm pkg set type=module",
      )
    }
  })
})
