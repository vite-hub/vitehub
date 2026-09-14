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
  it("renders ordinary Markdown paths and file URLs while preserving relative references", async () => {
    const root = await createRoot()
    await mkdir(join(root, "sections"))
    const path = join(root, "prompt with spaces.md")
    await writeFile(path, "# Review {{ repository }}\n\n@./sections/policy.md")
    await writeFile(join(root, "sections/policy.md"), "@../rules.md")
    await writeFile(join(root, "rules.md"), "Check {{ focus }}.")
    const options = { data: { repository: "*draft*", focus: "correctness" } }

    for (const input of [path, pathToFileURL(path), relative(process.cwd(), path)]) {
      await expect(renderMarkdownFile(input, options)).resolves.toBe("# Review \\*draft\\*\n\n@./sections/policy.md")
    }
  })

  it("reads updated files on each call and accepts runtime-selected paths", async () => {
    const root = await createRoot()
    const paths = [join(root, "success.md"), join(root, "failure.md")]
    await writeFile(paths[0]!, "Ready")
    await writeFile(paths[1]!, "Failed")
    await writeFile(join(root, "status.md"), "Ready")
    await expect(renderMarkdownFile(paths[0]!)).resolves.toBe("Ready")
    await writeFile(paths[0]!, "Done")
    await expect(renderMarkdownFile(paths[0]!)).resolves.toBe("Done")
    await expect(renderMarkdownFile(paths[1]!)).resolves.toBe("Failed")
  })

  it("renders a relocated file tree after the original source is removed", async () => {
    const root = await createRoot()
    const source = join(root, "source")
    const deployed = join(root, "deployed")
    await mkdir(source)
    await writeFile(join(source, "prompt.md"), "Review {{ number }}.\n\n@./policy.md")
    await cp(source, deployed, { recursive: true })
    await rm(source, { recursive: true })
    await expect(renderMarkdownFile(pathToFileURL(join(deployed, "prompt.md")), {
      data: { number: 42 },
    })).resolves.toBe("Review 42.\n\n@./policy.md")
  })

  it("reports missing root files but does not read references", async () => {
    const root = await createRoot()
    const path = join(root, "prompt.md")
    await expect(renderMarkdownFile(path)).rejects.toMatchObject({ code: "ENOENT" })
    await writeFile(path, "::if{enabled}\n@./missing.md\n::")
    await expect(renderMarkdownFile(path, { data: { enabled: false } })).resolves.toBe("")
    await expect(renderMarkdownFile(path, { data: { enabled: true } })).resolves.toBe("@./missing.md")
  })

  it("leaves import examples in code literal", async () => {
    const root = await createRoot()
    const path = join(root, "prompt.md")
    await writeFile(path, "`@./missing.md`\n\n```md\n@./missing.md\n```")
    await expect(renderMarkdownFile(path)).resolves.toContain("`@./missing.md`")
  })

  it("does not follow cyclic references", async () => {
    const root = await createRoot()
    const path = join(root, "prompt.md")
    await writeFile(path, "@./alias.md")
    await symlink(path, join(root, "alias.md"))
    await expect(renderMarkdownFile(path)).resolves.toBe("@./alias.md")
  })

  it("reads a symlink target without expanding its references", async () => {
    const root = await createRoot()
    await mkdir(join(root, "shared"))
    await writeFile(join(root, "shared/prompt.md"), "@./policy.md")
    await writeFile(join(root, "shared/policy.md"), "Shared policy")
    await symlink(join(root, "shared/prompt.md"), join(root, "prompt.md"))
    await expect(renderMarkdownFile(join(root, "prompt.md"))).resolves.toBe("@./policy.md")
  })

  it("rejects network file URLs but preserves absolute references", async () => {
    await expect(renderMarkdownFile(new URL("https://example.com/prompt.md"))).rejects.toThrow()
    const root = await createRoot()
    const path = join(root, "prompt.md")
    await writeFile(path, "@/private.md")
    await expect(renderMarkdownFile(path)).resolves.toBe("@/private.md")
  })
})
