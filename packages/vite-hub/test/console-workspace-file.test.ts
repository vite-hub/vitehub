import { describe, expect, it } from "vitest";
import { matchesWorkspaceFile } from "../src/console/runtime/components/console-workspace-file";

describe("Console Workspace file previews", () => {
  const file = { path: ".agents/skills/runs/SKILL.md", revision: "current" };

  it("accepts a requested file before the Workspace descriptor finishes loading", () => {
    expect(matchesWorkspaceFile(file, file.path)).toBe(true);
  });

  it("rejects files from a stale Workspace descriptor revision", () => {
    expect(matchesWorkspaceFile(file, file.path, { revision: "previous" })).toBe(false);
  });
});
