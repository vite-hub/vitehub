import { expect, it } from "vitest"

import { runAgentDevCli, runAgentEvalCli, runAgentInfoCli, runAgentInvocationsCli } from "../src/cli.ts"
import { runAgentChannelHistoryCli } from "../src/internal/channel-history-cli.ts"
import { runAgentChannelReplayCli } from "../src/internal/channel-replay-cli.ts"
import { runAgentChannelSyncCli } from "../src/internal/channel-sync-cli.ts"

function context() {
  let stderr = ""
  return {
    cwd: "/repo",
    env: {},
    rootDir: "/repo",
    stderr: { write: (chunk: string | Uint8Array) => { stderr += String(chunk) } },
    stdout: { write: () => {} },
    output: () => stderr,
  }
}

type Run = (cli: ReturnType<typeof context>) => Promise<number>

const commands: [string, Run, string, string][] = [
  ["agent eval", cli => runAgentEvalCli(["--threshold", "high"], cli, undefined), "AGENT_R0386", "Pass a number after --threshold"],
  ["agent dev", cli => runAgentDevCli(["--prompt", " "], cli), "AGENT_R0390", "Put the prompt text after -p or --prompt"],
  ["agent dev --input", cli => runAgentDevCli(["--input", "[]"], cli), "AGENT_R0398", "Pass --input a JSON object"],
  ["agent invocations", cli => runAgentInvocationsCli(["list", "--bogus"], cli), "AGENT_R0504", "Run vitehub agent invocations --help"],
  ["agent info", cli => runAgentInfoCli(["--bogus"], cli), "AGENT_R0499", "Run vitehub agent info --help"],
  ["channels history", cli => runAgentChannelHistoryCli(["--bogus"], cli), "AGENT_R0522", "Run vitehub channels history --help"],
  ["channels replay", cli => runAgentChannelReplayCli(["--agent=support", "--channel=slack", "stray"], cli), "AGENT_R0934", "Pass replayChannel()"],
  ["channels sync", cli => runAgentChannelSyncCli(["--bogus"], cli), "AGENT_R0536", "Run vitehub channels sync --help"],
]

it.each(commands)("%s prints the code and the fix of a coded error", async (_name, run, code, fix) => {
  const cli = context()
  await expect(run(cli)).resolves.toBe(1)
  expect(cli.output()).toContain(code)
  expect(cli.output()).toContain(fix)
})
