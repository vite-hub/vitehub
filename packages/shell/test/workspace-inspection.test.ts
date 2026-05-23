import { describe, expect, it } from "vitest"

import {
  createReadonlyWorkspaceFs,
  createWritableWorkspaceFs,
  runWorkspaceInspectionCommand,
  workspaceMountPoint,
} from "../src/workspace/index.ts"
import { MemoryWorkspace } from "./workspace-test-utils.ts"

describe("@vitehub/shell workspace inspection", () => {
  it("runs workspace inspection through the real shell runtime", async () => {
    const workspace = new MemoryWorkspace({
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

    await expect(runWorkspaceInspectionCommand(workspace, "rg --max-filesize 50K customers models", {
      commands: ["rg"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "models/customers.sql:1:select * from customers\n",
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

    await expect(runWorkspaceInspectionCommand(workspace, "grep -e customer models/customers.sql", {
      commands: ["grep"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "select * from customers\n",
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

    await expect(runWorkspaceInspectionCommand(workspace, "cat README.md | grep Docs -", {
      commands: ["cat", "grep"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      stderr: expect.not.stringContaining("Workspace path is not mounted"),
      stdout: "",
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

    await expect(runWorkspaceInspectionCommand(workspace, "cat ./orders.sql", {
      commands: ["cat"],
      cwd: "/workspace/models",
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "select * from orders\nwhere id is not null\n",
    })

    await expect(runWorkspaceInspectionCommand(workspace, "head --lines 1 missing/README.md", {
      commands: ["head"],
      cwd: workspaceMountPoint,
      fs,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Workspace path is not mounted: missing/README.md"),
    })
  })

})
