import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"

import { codex, run } from "@ai-hero/sandcastle"
import { docker } from "@ai-hero/sandcastle/sandboxes/docker"

const issueNumber = process.env.ISSUE_NUMBER || process.argv.slice(2).find((arg) => /^\d+$/.test(arg))

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

const issueJson = execFileSync(
  "gh",
  ["issue", "view", safeIssueNumber, "--repo", "vite-hub/vitehub", "--json", "number,title,body,labels,url"],
  { encoding: "utf8" },
).trim()

const currentBranch = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim()
const recentCommits = execFileSync("git", ["log", "--oneline", "-10"], { encoding: "utf8" }).trim()

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
  promptArgs: {
    ISSUE_JSON: issueJson,
    CURRENT_BRANCH: currentBranch,
    RECENT_COMMITS: recentCommits,
  },
  hooks: {
    sandbox: {
      onSandboxReady: [{ command: "corepack pnpm install --frozen-lockfile", timeoutMs: 300000 }],
    },
  },
})
