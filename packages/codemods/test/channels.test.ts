import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, describe, expect, it } from "vitest"

import { detectCodemods, runCodemod, upgradeCodemods } from "../src/index.ts"

const scratch = fileURLToPath(new URL("../.tmp/channels-test/", import.meta.url))

afterAll(() => rm(scratch, { recursive: true, force: true }))

async function migrate(files: Record<string, string>) {
  await mkdir(scratch, { recursive: true })
  const cwd = await mkdtemp(join(scratch, "app-"))
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true })
    await writeFile(join(cwd, path), contents)
  }
  const run = await runCodemod("channels", { cwd, dryRun: true })
  return { after: Object.fromEntries(run.result.edits.flatMap(edit => edit.after === null ? [] : [[edit.path, edit.after]])), cwd, run }
}

describe("channels", () => {
  it("runs in the release upgrade and is not detected after it", async () => {
    expect(upgradeCodemods.map(codemod => codemod.name)).toContain("channels")
    const { cwd } = await migrate({
      "server/channels/team.ts": "import { defineChannel } from 'vite-hub/channels'\nimport { http } from 'vite-hub/agent/channels'\n\nexport default defineChannel({ adapter: http() })\n",
    })
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).toContain("channels")
    await runCodemod("channels", { cwd, dryRun: false })
    expect(await readFile(join(cwd, "server/channels/team.ts"), "utf8")).toBe("import { defineChannel } from 'vite-hub/channels'\nimport { channelAdapter } from 'vite-hub/agent/channels'\n\nexport default defineChannel({ adapter: channelAdapter('http') })\n")
    expect((await detectCodemods(cwd)).map(entry => entry.codemod.name)).not.toContain("channels")
  })

  it("replaces http() with channelAdapter(\"http\") without changing the path", async () => {
    const { after } = await migrate({
      "server/agents/support.ts": [
        "import { defineAgent } from \"vite-hub/agent\"",
        "import { http, slack } from \"vite-hub/agent/channels\"",
        "",
        "export default defineAgent({",
        "  channels: { portal: http(({ route: true })), web: http(), slack: slack() },",
        "})",
        "",
      ].join("\n"),
    })
    expect(after["server/agents/support.ts"]).toBe([
      "import { defineAgent } from \"vite-hub/agent\"",
      "import { channelAdapter, slack } from \"vite-hub/agent/channels\"",
      "",
      "export default defineAgent({",
      "  channels: { portal: channelAdapter(\"http\", ({ route: true })), web: channelAdapter(\"http\"), slack: slack() },",
      "})",
      "",
    ].join("\n"))
  })

  it("keeps aliases and does not capture a shadowed channelAdapter", async () => {
    const { after } = await migrate({
      "server/agents/a.ts": "import { channelAdapter, http } from '@vite-hub/agent/channels'\nexport function configure(channelAdapter: (kind: string) => string) { return [http({ route: true }), channelAdapter('portal')] }\n",
      "server/agents/b.ts": "import { http as generic } from '@vite-hub/agent/channels'\nexport const b = generic()\n",
    })
    expect(after).toEqual({
      "server/agents/a.ts": "import { channelAdapter, channelAdapter as channelAdapter2 } from '@vite-hub/agent/channels'\nexport function configure(channelAdapter: (kind: string) => string) { return [channelAdapter2('http', { route: true }), channelAdapter('portal')] }\n",
      "server/agents/b.ts": "import { channelAdapter as generic } from '@vite-hub/agent/channels'\nexport const b = generic('http')\n",
    })
  })

  it.each([false, true])("keeps split imports valid (existing adapter first: %s)", async (adapterFirst) => {
    const oldImport = "import { http } from 'vite-hub/agent/channels'"
    const otherImport = "import { slack, channelAdapter } from 'vite-hub/agent/channels'"
    const imports = adapterFirst ? [otherImport, oldImport] : [oldImport, otherImport]
    const { after, run } = await migrate({ "split.ts": [...imports, "export const channels = [http /* (legacy) */ (), slack(), channelAdapter('custom')]"].join("\n") })
    expect(run.result.followUps).toEqual([])
    expect(after["split.ts"]).toBe([...imports.map(statement => statement.replace("{ http }", "{ channelAdapter as channelAdapter2 }")),
      "export const channels = [channelAdapter2 /* (legacy) */ ('http'), slack(), channelAdapter('custom')]"].join("\n"))
  })

  it.each([
    ["import { http } from 'vite-hub/agent/channels'\nhttp<AgentRuntimeConfig>()", "typed calls"],
    ["import { http } from 'vite-hub/agent/channels'\nhttp({ route: { admission: { context({ auth, body }) { return { auth, body } } } } })", "typed routes"],
    ["import * as channels from 'vite-hub/agent/channels'\nchannels.http()", "namespace import"],
    ["const { http } = await import('@vite-hub/agent/channels')\nhttp()", "module load"],
    ["export { http as portal } from 'vite-hub/agent/channels'", "removed"],
    ["import { defineChannel } from 'vite-hub/channels'\nvi.mock('vite-hub/agent/channels', () => ({ slack: fakeSlack }))", "mock"],
    ["import { http } from 'vite-hub/agent/channels'\nvi.doMock(import('vite-hub/agent/channels'), () => ({ http: fakeHttp }))\nhttp()", "mock"],
  ])("reports manual work without changing %s", async (source, message) => {
    const { after, run } = await migrate({ "manual.ts": source })
    expect(after).toEqual({})
    expect(run.result.followUps).toEqual([expect.objectContaining({ message: expect.stringContaining(message) })])
  })

  it("reports an http reference that is not a call, and leaves other http names", async () => {
    const { after, run } = await migrate({
      "server/agents/factory.ts": "import { http } from 'vite-hub/agent/channels'\nexport const make = http\n",
      "server/api/ping.ts": "import http from 'node:http'\nexport const server = http.createServer()\n",
    })
    expect(after).toEqual({})
    expect(run.result.followUps).toEqual([expect.objectContaining({ file: "server/agents/factory.ts", line: 2, message: expect.stringContaining("channelAdapter(\"http\", options)") })])
  })
})
