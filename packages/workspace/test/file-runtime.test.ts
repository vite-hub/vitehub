import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import * as workspace from "../src/index.ts";
import { registerWorkspace, resetWorkspaceRegistry } from "../src/core/registry.ts";
import { resetWorkspaceAssetsRegistry } from "../src/asset-registry.ts";

const legacy = workspace.useWorkspace;
const open = "useWorkspaceFiles" in workspace ? workspace.useWorkspaceFiles : legacy;

afterEach(() => {
  resetWorkspaceRegistry();
  resetWorkspaceAssetsRegistry();
});

describe("Workspace file runtime", () => {
  it("reads, writes, and snapshots files without constructing Agent tools", async () => {
    registerWorkspace("files", workspace.defineWorkspace({ store: { provider: "memory" } }));
    const files = open("files", { mode: "write" });
    await files.fs.writeFile("guide.md", "# Guide");
    const snapshot = await files.history.checkpoint({ message: "Guide" });
    expect(snapshot.id).toBeTruthy();
    expect(await open("files").fs.readFile("guide.md")).toBe("# Guide");
    expect("tools" in files).toBe(false);
    expect("tools" in open("files")).toBe(false);
  });

  it("keeps the optional shell out of a file consumer bundle", async () => {
    const name = "useWorkspaceFiles" in workspace ? "useWorkspaceFiles" : "useWorkspace";
    const result = await build({
      stdin: {
        contents: `export { ${name} } from "./dist/index.js"`,
        resolveDir: fileURLToPath(new URL("../", import.meta.url)),
      },
      bundle: true,
      format: "esm",
      platform: "node",
      packages: "external",
      write: false,
    });
    expect(result.outputFiles[0]!.text).not.toContain("@vite-hub/shell/workspace");
  });
});
