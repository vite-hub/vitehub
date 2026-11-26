import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { discoverMcpTools } from "../../mcp/src/vite.ts"
import { runSetup } from "./setup-helpers.ts"

const cliOf: Record<string, string[] | { none: string }> = {
  "check_app": ["apps", "check"],
  "get-page": { none: "A docs tool. Agents read the same pages at https://vitehub.dev/llms.txt." },
  "link_app": ["apps", "link"],
  "list-pages": { none: "A docs tool. Agents read the same pages at https://vitehub.dev/llms.txt." },
  "list_apps": ["apps", "list"],
  "list_operations": { none: "`vitehub project get --url <app>` lists operation names for the direct CLI caller, not MCP schemas or access." },
  "read_operation": { none: "Use the operation's CLI command with `--url <app>` and a separate app signing key, if the command exists." },
  "run_operation": { none: "Use the operation's CLI command with `--url <app>` and a separate app signing key, if the command exists." },
  "unlink_app": ["apps", "unlink"],
  "whoami": ["whoami"],
}

const consoleRoot = fileURLToPath(new URL("../../console/", import.meta.url))
const tools = discoverMcpTools({ rootDir: consoleRoot }).map(tool => tool.name).sort()

describe("the Console MCP and the CLI", () => {
  it("has a CLI command, or a reason, for each MCP tool", () => {
    expect(tools).toEqual(Object.keys(cliOf).sort())
  })

  it.each(Object.entries(cliOf).flatMap(([tool, command]) => Array.isArray(command) ? [[tool, command] as const] : []))("%s matches `vitehub %s`", async (_tool, command) => {
    const help = await runSetup([...command, "--help"], process.cwd())
    expect(help.exitCode, help.stderr).toBe(0)
    expect(help.stdout).toContain("Usage:")
  })
})
