import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import { renderMarkdownFile } from "../src/index.ts"

const roots: string[] = []

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-markdown-file-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe("renderMarkdownFile", () => {
  it("renders ordinary Markdown paths and file URLs with nested relative fragments", async () => {
    const root = await createRoot()
    await mkdir(join(root, "sections"))
    const path = join(root, "prompt with spaces.md")
    await writeFile(path, "# Review {{ repository }}\n\n@./sections/policy.md")
    await writeFile(join(root, "sections/policy.md"), "@../rules.md")
    await writeFile(join(root, "rules.md"), "Check {{ focus }}.")
    const options = { data: { repository: "*draft*", focus: "correctness" } }

    for (const input of [path, pathToFileURL(path), relative(process.cwd(), path)]) {
      await expect(renderMarkdownFile(input, options)).resolves.toBe("# Review \\*draft\\*\n\nCheck correctness.")
    }
  })

  it("reads updated files on each call and accepts runtime-selected paths", async () => {
    const root = await createRoot()
    const paths = [join(root, "success.md"), join(root, "failure.md")]
    await writeFile(paths[0]!, "@./status.md")
    await writeFile(paths[1]!, "Failed")
    await writeFile(join(root, "status.md"), "Ready")
    await expect(renderMarkdownFile(paths[0]!)).resolves.toBe("Ready")
    await writeFile(join(root, "status.md"), "Done")
    await expect(renderMarkdownFile(paths[0]!)).resolves.toBe("Done")
    await expect(renderMarkdownFile(paths[1]!)).resolves.toBe("Failed")
  })

  it("renders a relocated file tree after the original source is removed", async () => {
    const root = await createRoot()
    const source = join(root, "source")
    const deployed = join(root, "deployed")
    await mkdir(source)
    await writeFile(join(source, "prompt.md"), "@./policy.md")
    await writeFile(join(source, "policy.md"), "Review {{ number }}.")
    await cp(source, deployed, { recursive: true })
    await rm(source, { recursive: true })
    await expect(renderMarkdownFile(pathToFileURL(join(deployed, "prompt.md")), {
      data: { number: 42 },
    })).resolves.toBe("Review 42.")
  })

  it("reports missing root files and fragments at render time", async () => {
    const root = await createRoot()
    const path = join(root, "prompt.md")
    await expect(renderMarkdownFile(path)).rejects.toMatchObject({ code: "ENOENT" })
    await writeFile(path, "::if{enabled}\n@./missing.md\n::")
    await expect(renderMarkdownFile(path, { data: { enabled: false } })).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("leaves import examples in code literal", async () => {
    const root = await createRoot()
    const path = join(root, "prompt.md")
    await writeFile(path, "`@./missing.md`\n\n```md\n@./missing.md\n```")
    await expect(renderMarkdownFile(path)).resolves.toContain("`@./missing.md`")
  })

  it("enforces import depth and detects cycles through canonical file paths", async () => {
    const root = await createRoot()
    const path = join(root, "prompt.md")
    await writeFile(path, "@./policy.md")
    await writeFile(join(root, "policy.md"), "Policy")
    await expect(renderMarkdownFile(path, { maxImportDepth: 0 })).rejects.toThrow("depth exceeded 0")
    await expect(renderMarkdownFile(path, { maxImportDepth: 1 })).resolves.toBe("Policy")
    await symlink(path, join(root, "alias.md"))
    await writeFile(join(root, "policy.md"), "@./alias.md")
    await expect(renderMarkdownFile(path)).rejects.toThrow("Circular Markdown template import")
  })

  it("resolves fragments beside the canonical target of a symlink", async () => {
    const root = await createRoot()
    await mkdir(join(root, "shared"))
    await writeFile(join(root, "shared/prompt.md"), "@./policy.md")
    await writeFile(join(root, "shared/policy.md"), "Shared policy")
    await symlink(join(root, "shared/prompt.md"), join(root, "prompt.md"))
    await expect(renderMarkdownFile(join(root, "prompt.md"))).resolves.toBe("Shared policy")
  })

  it("rejects network URLs and absolute fragment imports", async () => {
    await expect(renderMarkdownFile(new URL("https://example.com/prompt.md"))).rejects.toThrow()
    const root = await createRoot()
    const path = join(root, "prompt.md")
    await writeFile(path, "@/private.md")
    await expect(renderMarkdownFile(path)).rejects.toThrow("must be a relative path")
  })
})
