import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"

import { codex, run } from "@ai-hero/sandcastle"
import { docker } from "@ai-hero/sandcastle/sandboxes/docker"

const issueNumber = process.env.ISSUE_NUMBER || process.argv[2]

if (!issueNumber) {
  throw new Error("Set ISSUE_NUMBER or pass an issue number: pnpm sandcastle -- 123")
}

const safeIssueNumber = issueNumber.replace(/[^0-9]/g, "")
if (!safeIssueNumber) {
  throw new Error(`Invalid issue number: ${issueNumber}`)
}

const branchName = `sandcastle/issue-${safeIssueNumber}-${new Date()
  .toISOString()
  .replaceAll(/[:.]/g, "-")}`

const codexHome = resolve(".agents/sandcastle/codex-home")
await mkdir(codexHome, { recursive: true })

if (!existsSync(".sandcastle")) {
  throw new Error("Expected .sandcastle to point at .agents/sandcastle")
}

await run({
  agent: codex("gpt-5.5", { effort: "low" }),
  sandbox: docker({
    imageName: "vitehub-sandcastle",
    env: {
      CODEX_HOME: "/home/agent/.codex",
      ISSUE_NUMBER: safeIssueNumber,
    },
    mounts: [
      {
        hostPath: codexHome,
        sandboxPath: "/home/agent/.codex",
      },
    ],
  }),
  branchStrategy: { type: "branch", branch: branchName },
  promptFile: "./.sandcastle/prompt.md",
  hooks: {
    sandbox: {
      onSandboxReady: [{ command: "corepack pnpm install --frozen-lockfile" }],
    },
  },
})
