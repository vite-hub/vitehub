import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { detectCodemods, runCodemod, upgradeCodemods } from "../src/index.ts"

const scratch = fileURLToPath(new URL("../.tmp/choices-package-test/", import.meta.url))

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function project(files: Record<string, string>): Promise<string> {
  await mkdir(scratch, { recursive: true })
  const cwd = await mkdtemp(join(scratch, "app-"))
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true })
    await writeFile(join(cwd, path), contents)
  }
  return cwd
}

describe("choices-package", () => {
  it("renames the imports, the dependency, and the CLI command, and is not detected after it", async () => {
    expect(upgradeCodemods.map(codemod => codemod.name)).toContain("choices-package")
    const cwd = await project({
      "package.json": `${JSON.stringify({ name: "shop", scripts: { choices: "vitehub decisions list" }, dependencies: { "@vite-hub/decisions": "^0.3.0", "@vite-hub/gateways": "^0.3.0", "vite-hub": "^0.3.0" } }, null, 2)}\n`,
      "server/utils/forecast.ts": "import { defineChoices } from 'vite-hub/decisions'\nimport type { ChoicesResult } from \"@vite-hub/decisions\"\nexport const forecast = defineChoices({ groups: {} })\n",
      "app/components/Search.vue": "<script setup lang=\"ts\">\nimport { useChoices } from 'vite-hub/decisions/vue'\nconst choices = useChoices('/api/choices')\n</script>\n",
      "server/api/decisions.ts": "export default { fetch: () => new Response('decisions') }\n",
    })
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).toContain("choices-package")
    const run = await runCodemod("choices-package", { cwd, dryRun: false })
    expect(run.result.nextSteps).toEqual([expect.stringContaining("install")])
    expect(await readFile(join(cwd, "server/utils/forecast.ts"), "utf8")).toBe("import { defineChoices } from 'vite-hub/choices'\nimport type { ChoicesResult } from \"@vite-hub/choices\"\nexport const forecast = defineChoices({ groups: {} })\n")
    expect(await readFile(join(cwd, "app/components/Search.vue"), "utf8")).toContain("import { useChoices } from 'vite-hub/choices/vue'")
    expect(await readFile(join(cwd, "server/api/decisions.ts"), "utf8")).toBe("export default { fetch: () => new Response('decisions') }\n")
    expect(JSON.parse(await readFile(join(cwd, "package.json"), "utf8"))).toEqual({
      name: "shop",
      scripts: { choices: "vitehub choices list" },
      dependencies: { "@vite-hub/choices": "^0.3.0", "@vite-hub/gateways": "^0.3.0", "vite-hub": "^0.3.0" },
    })
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).not.toContain("choices-package")
  })
})
