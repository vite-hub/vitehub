import { describe, expect, it } from "vitest"

import {
  createReadonlyWorkspaceFs,
  createWritableWorkspaceFs,
  runWorkspaceInspectionCommand,
  workspaceMountPoint,
} from "../src/workspace/index.ts"
import { MemoryWorkspace } from "./workspace-test-utils.ts"

describe("@vite-hub/shell workspace inspection", () => {
  it("runs workspace inspection through the real shell runtime", async () => {
    const workspace = new MemoryWorkspace({
      ".secret": "hidden\n",
      "README.md": "# Docs\n",
      "models/customers.sql": "select * from customers\n",
      "models/orders.sql": "select * from orders\n",
    })
    const fs = createReadonlyWorkspaceFs(workspace)

    await expect(runWorkspaceInspectionCommand(workspace, "cat README.md && pwd", {
      commands: ["cat", "pwd"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "# Docs\n/workspace\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cat README.md", {
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "# Docs\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "if true; then cat README.md; fi", {
      commands: ["cat"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "# Docs\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cat README.md | wc -l", {
      commands: ["cat", "wc"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "1\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "ls -la models", {
      commands: ["ls"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("customers.sql"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "ls .", {
      commands: ["ls"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "README.md\nmodels\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "ls -a .", {
      commands: ["ls"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: ".\n..\n.secret\nREADME.md\nmodels\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "ls -d models", {
      commands: ["ls"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "models\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "ls *.md", {
      commands: ["ls"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "README.md\n",
    })

    const slowFs = createReadonlyWorkspaceFs(workspace)
    slowFs.readdirWithFileTypes = async () => await new Promise(() => {})

    await expect(runWorkspaceInspectionCommand(workspace, "ls models", {
      commands: ["ls"],
      cwd: workspaceMountPoint,
      fs: slowFs,
      timeout: 20,
    })).resolves.toMatchObject({
      event: "command_timed_out",
      exitCode: null,
      stderr: expect.stringContaining("Workspace shell command timed out after 20ms"),
      timedOut: true,
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cat", {
      commands: ["cat"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "find . -type f -name '*.sql'", {
      commands: ["find"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      event: "policy_denied",
      exitCode: 126,
      stdout: expect.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "find . -maxdepth 1", {
      commands: ["find"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      event: "policy_denied",
      exitCode: 126,
      stdout: expect.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "find . -maxdepth 2 -name '*customer*'", {
      commands: ["find"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      event: "policy_denied",
      exitCode: 126,
      stdout: expect.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "wc -l", {
      commands: ["wc"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "0\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg orders models", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "models/orders.sql:1:select * from orders\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg -n orders models", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "models/orders.sql:1:select * from orders\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg --type sql orders models", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: expect.not.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg --type=sql orders models", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: expect.not.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg --iglob '*.sql' orders models", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: expect.not.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg --max-filesize 50K customers models", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "models/customers.sql:1:select * from customers\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg --ignore-file .rgignore customers models", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: expect.not.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg --ignore-file=.rgignore customers models", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: expect.not.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg --max-depth 1 customers models", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: expect.not.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg --max-depth=1 customers models", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: expect.not.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg '&&' models", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 1,
      stdout: expect.not.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "grep -ri customer models | head -n 1", {
      commands: ["grep", "head"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "models/customers.sql:select * from customers\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "head -c 6 README.md", {
      commands: ["head"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "# Docs",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "tail -c 6 README.md", {
      commands: ["tail"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: " Docs\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg orders models > search.txt", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs: createWritableWorkspaceFs(workspace),
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "",
    })
    await expect(workspace.readFile("search.txt")).resolves.toBe("models/orders.sql:1:select * from orders\n")

    await expect(runWorkspaceInspectionCommand(workspace, "find -L models -name '*.sql'", {
      commands: ["find"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 1,
      stdout: "",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "grep -ri customer . | grep -v orders | head -n 1", {
      commands: ["grep", "head"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      event: "policy_denied",
      exitCode: 126,
      stdout: expect.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg customer|orders models", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      event: "policy_denied",
      exitCode: 126,
      stdout: expect.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg customer forecasting-engine", {
      broadSearchPaths: ["forecasting-engine", "ingestion"],
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      event: "policy_denied",
      exitCode: 126,
      stdout: expect.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cat missing/README.md", {
      commands: ["cat"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Workspace path is not mounted: missing/README.md"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cat README.md", {
      commands: ["cat"],
      cwd: "/workspace/models",
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Workspace path is not mounted: models/README.md"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cat orders.sql", {
      commands: ["cat"],
      cwd: "/workspace/models",
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "select * from orders\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cd /workspace && rg orders models", {
      commands: ["cd", "rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "models/orders.sql:1:select * from orders\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cd /workspace && cat README.md", {
      commands: ["cat", "cd"],
      cwd: "/workspace/models",
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "# Docs\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cd && cat README.md", {
      commands: ["cat", "cd"],
      cwd: "/workspace/models",
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "# Docs\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cd models; cat orders.sql", {
      commands: ["cat", "cd"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("select * from orders"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cd models && cat missing.sql", {
      commands: ["cat", "cd"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Workspace path is not mounted: models/missing.sql"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cd models && rg orders .", {
      commands: ["cd", "rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "orders.sql:1:select * from orders\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cd models; rg orders .", {
      commands: ["cd", "rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "orders.sql:1:select * from orders\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cd models\nrg orders .", {
      commands: ["cd", "rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "orders.sql:1:select * from orders\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cd models && find -name '*.sql'", {
      commands: ["cd", "find"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.not.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "find -name '*.sql'", {
      commands: ["find"],
      cwd: "/workspace/models",
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.not.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "find -- models -name '*.sql'", {
      commands: ["find"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.not.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "find -name '*.sql'", {
      commands: ["find"],
      cwd: `${workspaceMountPoint}/models`,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "./customers.sql\n./orders.sql\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "find /workspace/models -name '*.sql'", {
      commands: ["find"],
      cwd: `${workspaceMountPoint}/models`,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "/workspace/models/customers.sql\n/workspace/models/orders.sql\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "find *.md -name README.md", {
      commands: ["find"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "README.md\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "find models -name", {
      commands: ["find"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("missing argument to `-name'"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg customers models && wc -l models/customers.sql", {
      commands: ["rg", "wc"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "models/customers.sql:1:select * from customers\n1 models/customers.sql\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg customers models || cat missing.sql", {
      commands: ["cat", "rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "models/customers.sql:1:select * from customers\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg missing models && cat missing.sql", {
      commands: ["cat", "rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 1,
      stdout: "",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg customers models || grep -v customer", {
      commands: ["grep", "rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      event: "policy_denied",
      exitCode: 126,
      stdout: expect.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cd missing || cat README.md", {
      commands: ["cat", "cd"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "# Docs\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cat missing.md || cat README.md", {
      commands: ["cat"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "# Docs\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cd README.md || rg customer .", {
      commands: ["cd", "rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      event: "policy_denied",
      exitCode: 126,
      stdout: expect.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cd models || cat README.md", {
      commands: ["cat", "cd"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cd models || cat missing.sql", {
      commands: ["cat", "cd"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cd models || cat missing.sql || cat missing-again.sql", {
      commands: ["cat", "cd"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cd missing && cat README.md", {
      commands: ["cat", "cd"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 1,
      stdout: "",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cd missing && cat missing/one.md && cat missing/two.md", {
      commands: ["cat", "cd"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 1,
      stdout: "",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "pwd && ls models", {
      commands: ["pwd", "ls"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "/workspace\ncustomers.sql\norders.sql\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "f=models/orders.sql; cat \"$f\"", {
      commands: ["cat"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("select * from orders"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cat \"$missing\"", {
      commands: ["cat"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: expect.not.stringContaining("Workspace path is not mounted"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "find models -type d -name \"forecast*\" | xargs -I {} rg -i \"class.*Forecast\" {} || true", {
      commands: ["find", "rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      event: "policy_denied",
      exitCode: 126,
      stderr: expect.stringContaining("Unsupported workspace shell command: xargs"),
      stdout: expect.stringContaining("Available workspace commands"),
    })
  })

  it("handles workspace inspection preflight parser edge cases", async () => {
    const workspace = new MemoryWorkspace({
      "README.md": "# Docs\n",
      "models/customers.sql": "select * from customers\n",
      "models/orders.sql": "select * from orders\nwhere id is not null\n",
      "flags.txt": "-foo\n",
      "patterns.txt": "customer\n",
    })
    const fs = createReadonlyWorkspaceFs(workspace)

    await expect(runWorkspaceInspectionCommand(workspace, "rg orders models > search.txt", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs: createWritableWorkspaceFs(workspace),
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "",
    })
    await expect(workspace.readFile("search.txt")).resolves.toBe("models/orders.sql:1:select * from orders\n")

    await expect(runWorkspaceInspectionCommand(workspace, "rg orders models >attached-search.txt", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs: createWritableWorkspaceFs(workspace),
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "",
    })
    await expect(workspace.readFile("attached-search.txt")).resolves.toBe("models/orders.sql:1:select * from orders\n")

    await expect(runWorkspaceInspectionCommand(workspace, "rg missing models 2>attached-error.txt", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs: createWritableWorkspaceFs(workspace),
    })).resolves.toMatchObject({
      exitCode: 1,
      stdout: "",
    })
    await expect(workspace.readFile("attached-error.txt")).resolves.toBe("")

    await expect(runWorkspaceInspectionCommand(workspace, "grep > grep-output.txt customer models/customers.sql", {
      commands: ["grep"],
      cwd: workspaceMountPoint,
      fs: createWritableWorkspaceFs(workspace),
    })).resolves.toMatchObject({
      exitCode: 0,
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: expect.not.stringContaining("Workspace path is not mounted"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "find -L models -name '*.sql'", {
      commands: ["find"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stdout: expect.not.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg orders models | grep -v customers", {
      commands: ["grep", "rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "models/orders.sql:1:select * from orders\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg orders models | grep -r orders", {
      commands: ["grep", "rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      event: "policy_denied",
      exitCode: 126,
      stdout: expect.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg orders models | grep -Ri orders", {
      commands: ["grep", "rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      event: "policy_denied",
      exitCode: 126,
      stdout: expect.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg orders models | grep --directories=recurse orders", {
      commands: ["grep", "rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      event: "policy_denied",
      exitCode: 126,
      stdout: expect.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg orders models | grep --directories recurse orders", {
      commands: ["grep", "rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      event: "policy_denied",
      exitCode: 126,
      stdout: expect.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cat README.md | grep -dread Docs", {
      commands: ["cat", "grep"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: expect.not.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "grep -e customer models/customers.sql", {
      commands: ["grep"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "select * from customers\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "grep -T customer models/customers.sql", {
      commands: ["grep"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: expect.not.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "grep -ecustomer models/customers.sql", {
      commands: ["grep"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: expect.not.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg -eorders models", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "models/orders.sql:1:select * from orders\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "grep -- '-foo' flags.txt", {
      commands: ["grep"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: expect.not.stringContaining("Workspace path is not mounted"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg -- '-foo' flags.txt", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: expect.not.stringContaining("Workspace path is not mounted"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "grep -f patterns.txt models/customers.sql", {
      commands: ["grep"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: expect.not.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "grep --file=patterns.txt models/customers.sql", {
      commands: ["grep"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: expect.not.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "grep --exclude-dir node_modules customer models", {
      commands: ["grep"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: expect.not.stringContaining("Workspace path is not mounted"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg --pre cat orders models", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: expect.not.stringContaining("Workspace path is not mounted"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cat README.md | grep Docs -", {
      commands: ["cat", "grep"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: "# Docs\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cat README.md | grep --regexp -r", {
      commands: ["cat", "grep"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace search is too broad"),
      stdout: expect.not.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cat -- README.md && ls models", {
      commands: ["cat", "ls"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "# Docs\ncustomers.sql\norders.sql\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "ls -I node_modules models", {
      commands: ["ls"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: expect.not.stringContaining("Workspace path is not mounted"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "ls --ignore node_modules models", {
      commands: ["ls"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: expect.not.stringContaining("Workspace path is not mounted"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "ls -A missing-dir", {
      commands: ["ls"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stdout: expect.stringContaining("Workspace path is not mounted: missing-dir"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cat -n missing.md", {
      commands: ["cat"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stdout: expect.stringContaining("Workspace path is not mounted: missing.md"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cat ./orders.sql", {
      commands: ["cat"],
      cwd: "/workspace/models",
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "select * from orders\nwhere id is not null\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg missing .", {
      commands: ["rg"],
      cwd: "/workspace/models",
      fs,
    })).resolves.toMatchObject({
      exitCode: 1,
      stdout: "",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "rg missing models && rg missing .", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 126,
      stdout: expect.stringContaining("Workspace search is too broad"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "head --lines 1 missing/README.md", {
      commands: ["head"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Workspace path is not mounted: missing/README.md"),
    })

    await expect(runWorkspaceInspectionCommand(workspace, "cat missing.md && pwd", {
      commands: ["cat", "pwd"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stdout: expect.stringContaining("Workspace path is not mounted: missing.md"),
    })
  })

})
