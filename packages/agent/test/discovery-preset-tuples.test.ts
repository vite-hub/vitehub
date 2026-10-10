import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { discoverAgentDefinitions } from "../src/discovery.ts"

it.each([
  ["owned Workspace", "const preset = defineAgent({ options: {}, configure: () => defineAgent({ workspace: {} }) });", "[preset, {}]", true],
  ["stateless parent", "const preset = defineAgent({ options: {}, configure: () => defineAgent({ driver: 'codex' }) });", "[preset, { workspace: {} }]", false],
  ["named Workspace reference", "const preset = defineAgent({ workspace: 'shared' });", "[preset, {}]", false],
  ["tuple alias", "const preset = defineAgent({ workspace: {} }); const extension = [preset, {}] as const;", "extension", true],
  ["leading fixed tuple spread", "const preset = defineAgent({ workspace: {} }); const parent = [preset] as const;", "[...parent, {}]", true],
  ["parent alias", "const preset = defineAgent({ workspace: {} }); const parent = preset;", "[parent, {}]", true],
  ["conditional tuple", "const preset = defineAgent({ workspace: {} }); const plain = defineAgent({});", "condition ? [plain, {}] : [preset, {}]", true],
  ["imported parent", "import { preset } from './preset';", "[preset, {}]", "imported Agent parent"],
  ["imported tuple alias", "import { preset } from './preset'; const extension = [preset, {}] as const;", "extension", "imported Agent parent"],
] as const)("discovers extension tuples: %s", async (_name, declarations, extension, ownership) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-preset-tuples-"))
  try {
    const folder = join(root, "server", "agents", "support")
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "agent.ts"), `${declarations}\nexport default defineAgent({ extends: ${extension} })`)
    const discover = () => discoverAgentDefinitions({ mode: "server-agents", scanDirs: [join(root, "server")] })
    if (typeof ownership === "string") expect(discover).toThrow(ownership)
    else {
      const definitions = discover()
      expect(definitions).toHaveLength(1)
      expect(definitions[0]?.workspace).toBe(ownership ? "support" : undefined)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
