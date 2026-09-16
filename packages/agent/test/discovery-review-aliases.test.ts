import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { discoverAgentDefinitions } from "../src/discovery.ts"

async function workspaceFor(source: string) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-discovery-review-alias-"))
  try {
    const folder = join(root, "server", "agents", "support")
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "agent.ts"), source)
    return discoverAgentDefinitions({ mode: "server-agents", scanDirs: [join(root, "server")] })[0]?.workspace
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

it.each(["@vite-hub/agent", "vite-hub/agent"])("discovers named and namespace Capability aliases from %s", async (module) => {
  for (const [imports, factory] of [
    [`import { defineCapability as capability } from "${module}"`, "capability"],
    [`import * as hub from "${module}"`, "hub.defineCapability"],
    [`import { defineCapability as capability } from "${module}"`, "capability<Runtime>"],
    [`import * as hub from "${module}"`, "hub.defineCapability<Runtime>"],
  ]) {
    for (const inline of [true, false]) {
      const declaration = inline ? "" : `const storage = ${factory}({ workspace: {} });`
      const capability = inline ? `${factory}({ workspace: {} })` : "storage"
      await expect(workspaceFor(`${imports}; ${declaration} export default defineAgent({ options: {}, configure: () => defineAgent({ capabilities: [${capability}] }) })`)).resolves.toBe("support")
    }
  }
})

it("does not recognize another package's similarly named factory", async () => {
  await expect(workspaceFor('import * as hub from "other-package"; export default defineAgent({ options: {}, configure: () => defineAgent({ capabilities: [hub.defineCapability({ workspace: {} })] }) })')).resolves.toBeUndefined()
})

it.each(["options", "(options)"])("preserves module Capabilities when the %s parameter shadows a declaration", async (parameters) => {
  await expect(workspaceFor(`const options = {}; const storage = defineCapability({ workspace: {} }); export default defineAgent({ options: {}, configure: ${parameters} => defineAgent({ capabilities: [storage] }) })`)).resolves.toBe("support")
})

it("preserves an unparenthesized callback parameter through callback aliases", async () => {
  await expect(workspaceFor('const options = {}; const storage = defineCapability({ workspace: {} }); const configure = options => defineAgent({ capabilities: [storage] }); const callback = configure; export default defineAgent({ options: {}, configure: callback })')).resolves.toBe("support")
})
