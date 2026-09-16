import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { discoverAgentDefinitions } from "../src/discovery.ts"

async function discover(source: string) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-imported-configure-"))
  try {
    const folder = join(root, "server", "agents", "notes")
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "agent.ts"), source)
    return discoverAgentDefinitions({ mode: "server-agents", scanDirs: [join(root, "server")] })
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
}

it.each([
  'import configure from "./configure"; export default defineAgent({ options: {}, configure })',
  'import { configure } from "./configure"; export default defineAgent({ options: {}, configure })',
  'import { configure as setup } from "./configure"; export default defineAgent({ options: {}, configure: setup })',
  'import * as callbacks from "./configure"; export default defineAgent({ options: {}, configure: callbacks.configure })',
  'import configure from "./configure"; const setup = configure; const callback = setup; export default defineAgent({ options: {}, configure: callback })',
])("rejects opaque imported configure callbacks before generating Workspace wiring: %s", async (source) => {
  await expect(discover(source)).rejects.toThrow("Agent Workspace discovery cannot inspect an imported configure callback")
})

it("discovers a locally defined callback that returns a Workspace Agent", async () => {
  const definitions = await discover('const configure = () => defineAgent({ workspace: {} }); export default defineAgent({ options: {}, configure })')
  expect(definitions[0]?.workspace).toBe("notes")
})

it.each(["options", "(options)", "(options: Options)"])("allows inline callback parameters to shadow imported bindings: %s", async (parameters) => {
  const definitions = await discover(`import options from "./options"; export default defineAgent({ options: {}, configure: ${parameters} => defineAgent({ workspace: {} }) })`)
  expect(definitions[0]?.workspace).toBe("notes")
})

it("does not inspect an unselected imported callback", async () => {
  const definitions = await discover('import configure from "./configure"; const unused = defineAgent({ options: {}, configure }); export default defineAgent({ workspace: {} })')
  expect(definitions[0]?.workspace).toBe("notes")
})

it("allows an aliased local callback whose parameter shadows an import", async () => {
  const definitions = await discover('import options from "./options"; const configure = (options: Options) => defineAgent({ workspace: {} }); const setup = configure; export default defineAgent({ options: {}, configure: setup })')
  expect(definitions[0]?.workspace).toBe("notes")
})
