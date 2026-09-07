import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getInvocation: vi.fn(),
  list: vi.fn(),
  readFile: vi.fn(),
  useWorkspace: vi.fn(),
}));

vi.mock("@vite-hub/workspace", () => ({
  useWorkspace: mocks.useWorkspace,
}));

vi.mock("../src/console/runtime/server/invocations.ts", () => ({
  getConsoleInvocations: () => ({ get: mocks.getInvocation }),
}));

import workspaceHandler from "../src/console/runtime/server/workspace.get.ts";

import type { ConsoleRequestEvent } from "../src/console/runtime/server/request.ts";

function request(path = ""): ConsoleRequestEvent {
  const url = `http://localhost/api/_vitehub/console/invocations/run-1/workspace${path}`;
  return {
    context: { params: { id: "run-1" } },
    headers: new Headers({ host: "localhost" }),
    method: "GET",
    node: { req: { method: "GET", socket: { remoteAddress: "127.0.0.1" }, url } },
    req: { method: "GET", url },
  };
}

describe("Console live workspace", () => {
  beforeEach(() => {
    mocks.getInvocation.mockReset().mockResolvedValue({ agentName: "support", id: "run-1" });
    mocks.list.mockReset().mockResolvedValue([
      { path: "src/index.ts", size: 17, type: "file" },
      { path: "src", type: "directory" },
    ]);
    mocks.readFile.mockReset().mockResolvedValue("export default 1\n");
    mocks.useWorkspace.mockReset().mockReturnValue({
      fs: {
        list: mocks.list,
        readFile: mocks.readFile,
      },
    });
  });

  it("uses the invocation agent's persistent workspace for listings and reads", async () => {
    await expect(workspaceHandler(request())).resolves.toEqual({
      live: true,
      paths: ["src/index.ts"],
      repository: "support",
      revision: "live",
    });
    expect(mocks.useWorkspace).toHaveBeenCalledWith("support", { mode: "read", refresh: false });
    expect(mocks.list).toHaveBeenCalledWith("", { recursive: true });

    await expect(workspaceHandler(request("?path=src%2Findex.ts"))).resolves.toEqual({
      content: "export default 1\n",
      path: "src/index.ts",
      revision: "live",
      size: 17,
    });
    expect(mocks.readFile).toHaveBeenCalledWith("src/index.ts");
  });

  it("lists root instructions and hidden skill files without substituting source guidance", async () => {
    mocks.list.mockResolvedValue([
      { path: "AGENTS.md", type: "file", size: 18 },
      { path: ".agents/skills/evidence/SKILL.md", type: "file", size: 20 },
      { path: "ingestion/AGENTS.md", type: "file", size: 12 },
    ]);
    mocks.readFile.mockImplementation(async (path: string) => path === "AGENTS.md" ? "Agent instructions" : "Source rules");
    await expect(workspaceHandler(request())).resolves.toMatchObject({
      paths: [".agents/skills/evidence/SKILL.md", "AGENTS.md", "ingestion/AGENTS.md"],
    });
    await expect(workspaceHandler(request("?path=AGENTS.md"))).resolves.toMatchObject({
      content: "Agent instructions", path: "AGENTS.md",
    });
  });

  it.each(["/etc/passwd", "../secret", "src/../secret", "src\\secret", "src//secret"])(
    "rejects unsafe paths before reading: %s",
    async (path) => {
      await expect(
        workspaceHandler(request(`?path=${encodeURIComponent(path)}`)),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(mocks.useWorkspace).not.toHaveBeenCalled();
    },
  );

  it("reports an unavailable workspace without exposing the storage error", async () => {
    mocks.list.mockRejectedValue(new Error("ENOENT: /private/storage/root"));

    await expect(workspaceHandler(request())).rejects.toMatchObject({
      message: 'Workspace is unavailable for agent "support"',
      statusCode: 503,
    });
  });

  it("returns not found for missing invocations and files", async () => {
    mocks.getInvocation.mockResolvedValueOnce(undefined);
    await expect(workspaceHandler(request())).rejects.toMatchObject({ statusCode: 404 });

    await expect(workspaceHandler(request("?path=missing.md"))).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(mocks.readFile).not.toHaveBeenCalled();
  });
});
