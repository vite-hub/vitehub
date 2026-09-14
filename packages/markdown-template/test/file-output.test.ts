import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { build } from "vite"
import { expect, it } from "vitest"

it("renders shipped Markdown files from a Vite server build without a template plugin", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-markdown-file-output-"))
  try {
    const source = join(root, "source")
    const output = join(root, "output")
    await mkdir(join(source, "templates"), { recursive: true })
    await writeFile(join(source, "templates/prompt.md"), "Review {{ repository }}.\n\n@./policy.md")
    await writeFile(join(source, "templates/policy.md"), "Review {{ repository }}.")
    const entry = join(source, "entry.ts")
    await writeFile(entry, [
      `import { renderMarkdownFile } from ${JSON.stringify(fileURLToPath(new URL("../dist/file.js", import.meta.url)))}`,
      `export default () => renderMarkdownFile(new URL("./templates/prompt.md", import.meta.url), { data: { repository: "ViteHub" } })`,
    ].join("\n"))
    await build({
      configFile: false,
      root,
      logLevel: "silent",
      build: {
        ssr: entry,
        outDir: output,
        rollupOptions: { output: { entryFileNames: "entry.mjs" } },
      },
    })
    await cp(join(source, "templates"), join(output, "templates"), { recursive: true })
    await rm(source, { recursive: true })
    expect(await readFile(join(output, "entry.mjs"), "utf8")).not.toContain("Review {{ repository }}.")
    // SAFETY: This test builds the fixture's declared default render function above.
    const deployed = await import(pathToFileURL(join(output, "entry.mjs")).href) as { default: () => Promise<string> }
    await expect(deployed.default()).resolves.toBe("Review ViteHub.\n\n@./policy.md")
    await rm(join(output, "templates/policy.md"))
    await expect(deployed.default()).resolves.toBe("Review ViteHub.\n\n@./policy.md")
    await rm(join(output, "templates/prompt.md"))
    await expect(deployed.default()).rejects.toMatchObject({ code: "ENOENT" })
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)
