import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requests: Array<{ body?: unknown; headers: Headers; method: string; path: string }> = [];
let refSha = "base-sha";
let remoteTreeSha = "base-tree";
let remoteTree: Array<{ path: string; sha: string; size?: number; type: "blob" }> = [];
let commitIndex = 0;
let treeIndex = 0;
const blobs = new Map<string, Uint8Array>();

function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

function textBytes(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

function textSha(content: string): string {
  return gitBlobSha(textBytes(content));
}

function seedRemote(path: string, content: string) {
  const bytes = textBytes(content);
  const sha = gitBlobSha(bytes);
  blobs.set(sha, bytes);
  remoteTree.push({ path, sha, size: bytes.byteLength, type: "blob" });
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

beforeEach(() => {
  requests.length = 0;
  refSha = "base-sha";
  remoteTreeSha = "base-tree";
  remoteTree = [];
  commitIndex = 0;
  treeIndex = 0;
  blobs.clear();
  delete process.env.WORKSPACE_GITHUB_TOKEN;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init.method || "GET";
      const body =
        typeof init.body === "string"
          ? (JSON.parse(init.body) as {
              content?: string;
              force?: boolean;
              sha?: string | null;
              tree?: Array<{ path: string; sha: string | null; type: "blob" }>;
            })
          : undefined;
      requests.push({ body, headers: new Headers(init.headers), method, path: url.pathname });

      if (url.pathname === "/repos/onmax/repo/git/ref/heads/main")
        return jsonResponse({ object: { sha: refSha } });
      if (url.pathname.startsWith("/repos/onmax/repo/git/commits/"))
        return jsonResponse({ tree: { sha: remoteTreeSha } });
      if (url.pathname === `/repos/onmax/repo/git/trees/${remoteTreeSha}` && method === "GET")
        return jsonResponse({ tree: remoteTree });
      if (url.pathname.startsWith("/repos/onmax/repo/git/blobs/") && method === "GET") {
        const sha = url.pathname.split("/").at(-1)!;
        const bytes = blobs.get(sha);
        return bytes
          ? jsonResponse({ content: Buffer.from(bytes).toString("base64"), encoding: "base64" })
          : new Response("not found", { status: 404 });
      }
      if (url.pathname === "/repos/onmax/repo/git/blobs" && method === "POST" && body?.content) {
        const bytes = new Uint8Array(Buffer.from(body.content, "base64"));
        const sha = gitBlobSha(bytes);
        blobs.set(sha, bytes);
        return jsonResponse({ sha });
      }
      if (url.pathname === "/repos/onmax/repo/git/trees" && method === "POST") {
        for (const entry of body?.tree || []) {
          remoteTree = remoteTree.filter((item) => item.path !== entry.path);
          if (entry.sha) {
            const bytes = blobs.get(entry.sha);
            remoteTree.push({
              path: entry.path,
              sha: entry.sha,
              size: bytes?.byteLength,
              type: "blob",
            });
          }
        }
        remoteTreeSha = `tree-sha-${++treeIndex}`;
        return jsonResponse({ sha: remoteTreeSha });
      }
      if (url.pathname === "/repos/onmax/repo/git/commits" && method === "POST")
        return jsonResponse({ sha: `commit-sha-${++commitIndex}` });
      if (url.pathname === "/repos/onmax/repo/git/refs/heads/main" && method === "PATCH") {
        if (body?.sha) refSha = body.sha;
        return jsonResponse({});
      }

      return new Response("not found", { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WORKSPACE_GITHUB_TOKEN;
});

describe("GitHub workspace store", () => {
  it("reads, lists, stats, writes, snapshots, and persists metadata through GitHub", async () => {
    seedRemote(".vitehub/workspaces/docs/data/existing.json", '{"ok":true}\n');
    const { createGitHubWorkspaceStore } = await import("../src/providers/github/store.ts");
    const store = createGitHubWorkspaceStore(
      {
        provider: "github",
        repository: "onmax/repo",
        root: ".vitehub/workspaces/<workspace>",
        token: "token",
      },
      "docs",
    );

    await expect(store.readFile("data/existing.json")).resolves.toMatchObject({
      content: textBytes('{"ok":true}\n'),
      path: "data/existing.json",
    });
    await expect(store.list("", { recursive: true })).resolves.toEqual([
      expect.objectContaining({ path: "data", type: "directory" }),
      expect.objectContaining({
        digest: textSha('{"ok":true}\n'),
        path: "data/existing.json",
        type: "file",
      }),
    ]);
    await expect(store.stat("data/existing.json")).resolves.toMatchObject({
      digest: textSha('{"ok":true}\n'),
      path: "data/existing.json",
      type: "file",
    });

    await store.writeFile("tasks/todo.md", {
      path: "tasks/todo.md",
      content: "ship it\n",
      mediaType: "text/markdown",
    });
    await store.setMeta!("loader", { digest: "abc" });

    const snapshot = await store.snapshot({ name: "sync workspace" });
    expect(snapshot.id).toBe("commit-sha-1");
    expect(await store.getMeta!("loader")).toEqual({ digest: "abc" });
    expect(
      requests.find((request) => request.path.endsWith("/git/trees") && request.method === "POST")
        ?.body,
    ).toMatchObject({
      base_tree: "base-tree",
      tree: expect.arrayContaining([
        {
          mode: "100644",
          path: ".vitehub/workspaces/docs/tasks/todo.md",
          sha: textSha("ship it\n"),
          type: "blob",
        },
        {
          mode: "100644",
          path: ".vitehub/workspaces/docs/.vitehub/meta/loader.json",
          sha: textSha('{"digest":"abc"}'),
          type: "blob",
        },
      ]),
    });
    expect(
      requests.find((request) => request.path.endsWith("/git/commits") && request.method === "POST")
        ?.body,
    ).toMatchObject({
      message: "sync workspace",
      parents: ["base-sha"],
      tree: "tree-sha-1",
    });
    expect(
      requests.find(
        (request) => request.path.endsWith("/git/refs/heads/main") && request.method === "PATCH",
      )?.body,
    ).toMatchObject({
      force: false,
      sha: "commit-sha-1",
    });

    const freshStore = createGitHubWorkspaceStore(
      {
        provider: "github",
        repository: "onmax/repo",
        root: ".vitehub/workspaces/<workspace>",
        token: "token",
      },
      "docs",
    );
    await expect(freshStore.getMeta!("loader")).resolves.toEqual({ digest: "abc" });
  });

  it("deletes files and directories through snapshot commits", async () => {
    seedRemote(".vitehub/workspaces/docs/tasks/a.md", "a\n");
    seedRemote(".vitehub/workspaces/docs/tasks/b.md", "b\n");
    const { createGitHubWorkspaceStore } = await import("../src/providers/github/store.ts");
    const store = createGitHubWorkspaceStore(
      {
        provider: "github",
        repository: "onmax/repo",
        root: ".vitehub/workspaces/<workspace>",
        token: "token",
      },
      "docs",
    );

    await expect(store.rm("tasks")).rejects.toThrow("Workspace directory is not empty");
    await store.rm("tasks", { recursive: true });
    await store.snapshot({ name: "delete tasks" });

    expect(
      requests.find((request) => request.path.endsWith("/git/trees") && request.method === "POST")
        ?.body,
    ).toMatchObject({
      tree: expect.arrayContaining([
        { mode: "100644", path: ".vitehub/workspaces/docs/tasks/a.md", sha: null, type: "blob" },
        { mode: "100644", path: ".vitehub/workspaces/docs/tasks/b.md", sha: null, type: "blob" },
      ]),
    });
  });

  it("skips no-op snapshots after comparing the remote tree", async () => {
    seedRemote(".vitehub/workspaces/docs/README.md", "# Docs\n");
    const { createGitHubWorkspaceStore } = await import("../src/providers/github/store.ts");
    const store = createGitHubWorkspaceStore(
      {
        provider: "github",
        repository: "onmax/repo",
        root: ".vitehub/workspaces/<workspace>",
        token: "token",
      },
      "docs",
    );

    await store.writeFile("README.md", { path: "README.md", content: "# Docs\n" });
    await store.snapshot({ name: "unchanged" });

    expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
  });

  it("diffs a fresh loaded store from the remote baseline", async () => {
    seedRemote(".vitehub/workspaces/docs/README.md", "# Docs\n");
    const { createGitHubWorkspaceStore } = await import("../src/providers/github/store.ts");
    const store = createGitHubWorkspaceStore(
      {
        provider: "github",
        repository: "onmax/repo",
        root: ".vitehub/workspaces/<workspace>",
        token: "token",
      },
      "docs",
    );

    await expect(store.diff()).resolves.toMatchObject({ entries: [] });
  });

  it("uploads changed blobs during writes and snapshots by sha", async () => {
    const { createGitHubWorkspaceStore } = await import("../src/providers/github/store.ts");
    const store = createGitHubWorkspaceStore(
      {
        provider: "github",
        repository: "onmax/repo",
        root: ".vitehub/workspaces/<workspace>",
        token: "token",
      },
      "docs",
    );

    await store.writeFile("tasks/todo.md", {
      path: "tasks/todo.md",
      content: "ship it\n",
      mediaType: "text/markdown",
    });

    expect(
      requests.filter((request) => request.path.endsWith("/git/blobs") && request.method === "POST"),
    ).toHaveLength(1);
    requests.length = 0;

    await store.snapshot({ name: "sync workspace" });

    expect(
      requests.filter((request) => request.path.endsWith("/git/blobs") && request.method === "POST"),
    ).toEqual([]);
    expect(
      requests.find((request) => request.path.endsWith("/git/trees") && request.method === "POST")
        ?.body,
    ).toMatchObject({
      tree: expect.arrayContaining([
        {
          mode: "100644",
          path: ".vitehub/workspaces/docs/tasks/todo.md",
          sha: textSha("ship it\n"),
          type: "blob",
        },
      ]),
    });
  });

  it("supports streaming writes in the GitHub workspace store", async () => {
    const { createGitHubWorkspaceStore } = await import("../src/providers/github/store.ts");
    const store = createGitHubWorkspaceStore(
      {
        provider: "github",
        repository: "onmax/repo",
        root: ".vitehub/workspaces/<workspace>",
        token: "token",
      },
      "docs",
    );

    await expect(store.writeFileStream!("assets/blob.txt", {
      path: "assets/blob.txt",
      content: new ReadableStream({
        start(controller) {
          controller.enqueue(textBytes("hello "));
          controller.enqueue(textBytes("stream\n"));
          controller.close();
        },
      }),
      mediaType: "text/plain",
    })).resolves.toMatchObject({
      digest: textSha("hello stream\n"),
      path: "assets/blob.txt",
      size: textBytes("hello stream\n").byteLength,
    });
    await store.snapshot({ name: "sync workspace" });

    expect(
      requests.find((request) => request.path.endsWith("/git/trees") && request.method === "POST")
        ?.body,
    ).toMatchObject({
      tree: expect.arrayContaining([
        {
          mode: "100644",
          path: ".vitehub/workspaces/docs/assets/blob.txt",
          sha: textSha("hello stream\n"),
          type: "blob",
        },
      ]),
    });
  });

  it("keeps unchanged remote file content lazy after no-op writes", async () => {
    seedRemote(".vitehub/workspaces/docs/README.md", "# Docs\n");
    const { createGitHubWorkspaceStore } = await import("../src/providers/github/store.ts");
    const store = createGitHubWorkspaceStore(
      {
        provider: "github",
        repository: "onmax/repo",
        root: ".vitehub/workspaces/<workspace>",
        token: "token",
      },
      "docs",
    );

    await store.writeFile("README.md", { path: "README.md", content: "# Docs\n" });
    requests.length = 0;

    await expect(store.readFile("README.md")).resolves.toMatchObject({
      content: textBytes("# Docs\n"),
      metadata: undefined,
    });

    expect(requests.filter((request) => request.path.includes("/git/blobs/"))).toEqual([
      expect.objectContaining({
        method: "GET",
        path: `/repos/onmax/repo/git/blobs/${textSha("# Docs\n")}`,
      }),
    ]);
  });

  it("fails dirty snapshots when the branch moved after load", async () => {
    const { createGitHubWorkspaceStore } = await import("../src/providers/github/store.ts");
    const store = createGitHubWorkspaceStore(
      {
        provider: "github",
        repository: "onmax/repo",
        root: ".vitehub/workspaces/<workspace>",
        token: "token",
      },
      "docs",
    );

    await store.writeFile("README.md", { path: "README.md", content: "# Docs\n" });
    refSha = "other-commit";

    await expect(store.snapshot({ name: "conflict" })).rejects.toThrow(
      "GitHub Workspace Store conflict",
    );
    expect(
      requests.filter((request) =>
        (request.path.endsWith("/git/trees") && request.method === "POST")
        || request.path.endsWith("/git/commits")
        || request.method === "PATCH"
      ),
    ).toEqual([]);
  });

  it("requires repository and token configuration", async () => {
    const { createGitHubWorkspaceStore } = await import("../src/providers/github/store.ts");

    expect(() =>
      createGitHubWorkspaceStore(
        {
          provider: "github",
          repository: "onmax/repo",
          token: "",
        },
        "docs",
      ),
    ).toThrow("requires a token");
    expect(() =>
      createGitHubWorkspaceStore(
        {
          provider: "github",
          repository: "malformed",
          token: "token",
        },
        "docs",
      ),
    ).not.toThrow();
    const store = createGitHubWorkspaceStore(
      {
        provider: "github",
        repository: "malformed",
        token: "token",
      },
      "docs",
    );
    await expect(store.list()).rejects.toThrow("requires a repository in owner/repo format");
  });
});
