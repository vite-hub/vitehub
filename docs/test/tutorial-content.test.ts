import { readFile, readdir } from "node:fs/promises"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

const docsRoot = resolve(import.meta.dirname, "..")

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...await markdownFiles(path))
    else if (entry.isFile() && path.endsWith(".md")) files.push(path)
  }

  return files
}

function labels(source: string) {
  return [...source.matchAll(/^```[^\n]*\[([^\]]+)\]/gm)].map(match => match[1])
}

describe("multi-file tutorial examples", () => {
  it("shows the entrypoint and ordered Workflow steps together", async () => {
    const source = await readFile(resolve(docsRoot, "content/docs/workflows/get-started.md"), "utf8")
    const files = labels(source)

    expect(files).toEqual(expect.arrayContaining([
      "server/workflows/onboard-user/index.ts",
      "server/workflows/onboard-user/01.create-user.ts",
      "server/workflows/onboard-user/02.send-welcome.ts",
      "server/api/onboard.post.ts",
    ]))
    expect(source).toContain("each step can be retried or replayed independently")
    expect(source).toContain("01.create-user")
    expect(source).toContain("02.send-welcome")
  })

  it("distinguishes the Sandbox package from the app route and response", async () => {
    const source = await readFile(resolve(docsRoot, "content/docs/sandbox/get-started.md"), "utf8")
    const files = labels(source)

    expect(files).toEqual(expect.arrayContaining([
      "server/sandboxes/image-optimizer/package.json",
      "server/sandboxes/image-optimizer/index.ts",
      "server/api/image-optimizer.post.ts",
      "output/image-optimizer.json",
    ]))
    expect(source).toContain("a separate package project, not another server route")
    expect(source).toContain("This JSON is the response body, not a file")
  })

  it("keeps command and output snippets in semantic virtual folders", async () => {
    const tutorials = await markdownFiles(resolve(docsRoot, "content/docs"))

    for (const path of tutorials) {
      const source = await readFile(path, "utf8")
      if (!source.includes("layout: tutorial")) continue

      const virtualLabels = labels(source).filter(label => label.startsWith("commands/") || label.startsWith("output/"))
      expect(labels(source).filter(label => /^(Terminal|Response|Output)(?::|$)/.test(label)), path).toEqual([])
      expect(new Set(virtualLabels).size, path).toBe(virtualLabels.length)
    }
  })

  it("keeps code labels unique within each tutorial", async () => {
    const tutorials = await markdownFiles(resolve(docsRoot, "content/docs"))

    for (const path of tutorials) {
      const source = await readFile(path, "utf8")
      if (!source.includes("layout: tutorial")) continue

      const tutorialLabels = labels(source)
      expect(new Set(tutorialLabels).size, path).toBe(tutorialLabels.length)
    }
  })

  it("keeps UI installation examples in separate project folders", async () => {
    const source = await readFile(resolve(docsRoot, "content/docs/ui/installation.md"), "utf8")
    const files = labels(source)

    expect(files).toEqual(expect.arrayContaining([
      "nuxt/nuxt.config.ts",
      "nuxt/app.vue",
      "vite/vite.config.ts",
      "vite/src/main.ts",
      "vite/src/assets/main.css",
      "vite/src/components/Example.vue",
      "nuxt/defaults/nuxt.config.ts",
      "vite/defaults/src/main.ts",
      "vite/theme/src/assets/main.css",
    ]))
    expect(files).not.toContain("nuxt.config.ts")
    expect(files).not.toContain("src/main.ts")
    expect(files).not.toContain("src/assets/main.css")
    expect(files).not.toContain("src/components/Example.vue")
  })
})
