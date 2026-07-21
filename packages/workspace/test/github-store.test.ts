import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearActiveCloudflareEnv, setActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env";

const requests: Array<{ body?: unknown; headers: Headers; method: string; path: string }> = [];
let refSha = "base-sha";
let remoteTreeSha = "base-tree";
let remoteTree: Array<{ mode?: string; path: string; sha: string; size?: number; type: "blob" }> = [];
let commitIndex = 0;
let treeIndex = 0;
let mirrorRefSha: string | undefined;
let mirrorRefStatus = 404;
const blobs = new Map<string, Uint8Array>();
const jsonBlobResponses = new Set<string>();

function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

function textBytes(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

function textSha(content: string): string {
  return gitBlobSha(textBytes(content));
}

function seedRemote(path: string, content: string, mode?: string) {
  const bytes = textBytes(content);
  const sha = gitBlobSha(bytes);
  blobs.set(sha, bytes);
  remoteTree.push({ mode, path, sha, size: bytes.byteLength, type: "blob" });
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
  mirrorRefSha = undefined;
  mirrorRefStatus = 404;
  blobs.clear();
  jsonBlobResponses.clear();
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
              ref?: string;
              sha?: string | null;
              tree?: Array<{ mode?: string; path: string; sha: string | null; type: "blob" }>;
            })
          : undefined;
      requests.push({ body, headers: new Headers(init.headers), method, path: url.pathname });

      if (url.pathname === "/repos/onmax/repo/git/ref/heads/mirror") {
        if (mirrorRefSha) return jsonResponse({ object: { sha: mirrorRefSha } });
        return new Response("missing mirror branch", {
          status: mirrorRefStatus,
          statusText: mirrorRefStatus === 404 ? "Not Found" : "Forbidden",
        });
      }
      if (url.pathname === "/repos/onmax/repo") return jsonResponse({ default_branch: "main" });
      if (url.pathname === "/repos/onmax/repo/git/ref/heads/main")
        return jsonResponse({ object: { sha: refSha } });
      if (url.pathname.startsWith("/repos/onmax/repo/git/commits/"))
        return jsonResponse({ tree: { sha: remoteTreeSha } });
      if (url.pathname === `/repos/onmax/repo/git/trees/${remoteTreeSha}` && method === "GET")
        return jsonResponse({ tree: remoteTree });
      if (url.pathname.startsWith("/repos/onmax/repo/git/blobs/") && method === "GET") {
        const sha = url.pathname.split("/").at(-1)!;
        const bytes = blobs.get(sha);
        if (bytes && jsonBlobResponses.has(sha)) {
          return jsonResponse({
            content: Buffer.from(bytes).toString("base64"),
            encoding: "base64",
          });
        }
        return bytes
          ? new Response(bytes, {
              headers: { "content-type": "application/octet-stream" },
              status: 200,
            })
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
              mode: entry.mode,
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
      if (url.pathname === "/repos/onmax/repo/git/refs" && method === "POST") {
        if (body?.ref === "refs/heads/mirror" && body.sha) mirrorRefSha = body.sha;
        return jsonResponse({});
      }
      if (url.pathname === "/repos/onmax/repo/git/refs/heads/mirror" && method === "PATCH") {
        if (body?.sha) mirrorRefSha = body.sha;
        return jsonResponse({});
      }
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
  clearActiveCloudflareEnv();
});

describe("GitHub workspace store", () => {
  it.each(["********", "<redacted>", "[redacted]"])(
    "falls back to env credentials for masked token %s",
    async (maskedToken) => {
      process.env.WORKSPACE_GITHUB_TOKEN = "env-token";
      const { createGitHubWorkspaceStore } = await import("../src/providers/github/store.ts");
      const store = createGitHubWorkspaceStore(
        {
          provider: "github",
          repository: "onmax/repo",
          root: ".vitehub/workspaces/<workspace>",
          token: maskedToken,
        },
        "docs",
      );

      await expect(store.list("", { recursive: true })).resolves.toEqual([]);

      expect(requests[0]?.headers.get("authorization")).toBe("Bearer env-token");
    },
  );

  it.each(["********", "<redacted>", "[redacted]"])(
    "falls back to env credentials for masked active binding %s",
    async (maskedToken) => {
      process.env.WORKSPACE_GITHUB_TOKEN = "env-token";
      setActiveCloudflareEnv({ GITHUB_TOKEN: maskedToken });
      const { createGitHubWorkspaceStore } = await import("../src/providers/github/store.ts");
      const store = createGitHubWorkspaceStore(
        {
          provider: "github",
          repository: "onmax/repo",
          root: ".vitehub/workspaces/<workspace>",
        },
        "docs",
      );

      await expect(store.list("", { recursive: true })).resolves.toEqual([]);

      expect(requests[0]?.headers.get("authorization")).toBe("Bearer env-token");
    },
  );

  it("uses lazy options preserved by runtime GitHub store normalization", async () => {
    const { normalizeWorkspaceStoreOptions } = await import("../src/config.ts");
    const { createGitHubWorkspaceStore } = await import("../src/providers/github/store.ts");
    const normalized = normalizeWorkspaceStoreOptions(
      {
        provider: "github",
        repository: () => "onmax/repo",
        root: () => ".vitehub/workspaces/<workspace>",
        token: () => "callback-token",
      },
      { env: {}, runtime: true },
    );
    if (!normalized || normalized.provider !== "github") throw new Error("Expected GitHub workspace store options.");
    const store = createGitHubWorkspaceStore(normalized, "docs");

    await expect(store.list("", { recursive: true })).resolves.toEqual([]);

    expect(requests[0]?.headers.get("authorization")).toBe("Bearer callback-token");
  });

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
    expect(
      requests.find(request => request.path.includes("/git/blobs/") && request.method === "GET")
        ?.headers.get("accept"),
    ).toBe("application/vnd.github.raw+json");
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

  it("creates a missing branch from the default branch before using non-forced updates", async () => {
    const { createGitHubWorkspaceStore } = await import("../src/providers/github/store.ts");
    const store = createGitHubWorkspaceStore(
      {
        branch: "mirror",
        provider: "github",
        repository: "onmax/repo",
        root: ".vitehub/workspaces/<workspace>",
        token: "token",
      },
      "docs",
    );

    await store.writeFile("tasks/first.md", { path: "tasks/first.md", content: "first\n" });
    await store.snapshot({ name: "first publish" });

    expect(requests.map(request => request.path)).toEqual(expect.arrayContaining([
      "/repos/onmax/repo/git/ref/heads/mirror",
      "/repos/onmax/repo",
      "/repos/onmax/repo/git/ref/heads/main",
    ]));
    expect(
      requests.find(request => request.path.endsWith("/git/trees") && request.method === "POST")
        ?.body,
    ).toMatchObject({ base_tree: "base-tree" });
    expect(
      requests.find(request => request.path.endsWith("/git/commits") && request.method === "POST")
        ?.body,
    ).toMatchObject({ parents: ["base-sha"] });
    expect(
      requests.find(request => request.path === "/repos/onmax/repo/git/refs" && request.method === "POST")
        ?.body,
    ).toEqual({ ref: "refs/heads/mirror", sha: "commit-sha-1" });
    expect(requests.some(request => request.method === "PATCH")).toBe(false);

    requests.length = 0;
    await store.writeFile("tasks/second.md", { path: "tasks/second.md", content: "second\n" });
    await store.snapshot({ name: "second publish" });

    expect(
      requests.find(request => request.path.endsWith("/git/refs/heads/mirror") && request.method === "PATCH")
        ?.body,
    ).toEqual({ force: false, sha: "commit-sha-2" });
    expect(requests.some(request => request.path === "/repos/onmax/repo/git/refs" && request.method === "POST")).toBe(false);
  });

  it("does not treat non-404 branch failures as missing", async () => {
    mirrorRefStatus = 403;
    const { createGitHubWorkspaceStore } = await import("../src/providers/github/store.ts");
    const store = createGitHubWorkspaceStore(
      {
        branch: "mirror",
        provider: "github",
        repository: "onmax/repo",
        token: "token",
      },
      "docs",
    );

    await expect(store.list()).rejects.toThrow("403 Forbidden");
    expect(requests.map(request => request.path)).toEqual([
      "/repos/onmax/repo/git/ref/heads/mirror",
    ]);
  });

  it("decodes GitHub JSON blob responses when raw bytes are unavailable", async () => {
    const content = "fallback\n";
    const sha = textSha(content);
    seedRemote(".vitehub/workspaces/docs/data/fallback.txt", content);
    jsonBlobResponses.add(sha);
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

    await expect(store.readFile("data/fallback.txt")).resolves.toMatchObject({
      content: textBytes(content),
      path: "data/fallback.txt",
    });
    expect(
      requests.find(request => request.path.includes("/git/blobs/") && request.method === "GET")
        ?.headers.get("accept"),
    ).toBe("application/vnd.github.raw+json");
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
        branch: "mirror",
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

  it("reads GitHub symlink blobs from their in-workspace target", async () => {
    seedRemote(".vitehub/workspaces/docs/AGENTS.md", "# Instructions\n");
    const target = textBytes("AGENTS.md");
    const sha = gitBlobSha(target);
    blobs.set(sha, target);
    remoteTree.push({
      mode: "120000",
      path: ".vitehub/workspaces/docs/CLAUDE.md",
      sha,
      size: target.byteLength,
      type: "blob",
    });
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

    await expect(store.readFile("CLAUDE.md")).resolves.toMatchObject({
      content: textBytes("# Instructions\n"),
      path: "CLAUDE.md",
    });
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

  it("marks GitHub symlink blobs from the remote tree", async () => {
    seedRemote(".vitehub/workspaces/docs/AGENTS.md", "# Agents\n");
    seedRemote(".vitehub/workspaces/docs/CLAUDE.md", "AGENTS.md", "120000");
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

    await expect(store.stat("CLAUDE.md")).resolves.toMatchObject({
      metadata: { gitMode: "120000", symlinkTarget: "AGENTS.md" },
      path: "CLAUDE.md",
      type: "file",
    });
    await expect(store.readFile("CLAUDE.md")).resolves.toMatchObject({
      content: textBytes("# Agents\n"),
      metadata: { gitMode: "120000", symlinkTarget: "AGENTS.md" },
    });
  });

  it("round-trips GitHub symlink metadata without replacing the link target bytes", async () => {
    seedRemote(".vitehub/workspaces/docs/AGENTS.md", "# Agents\n");
    seedRemote(".vitehub/workspaces/docs/CLAUDE.md", "AGENTS.md", "120000");
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

    const file = await store.readFile("CLAUDE.md");
    expect(file).toBeDefined();
    await store.writeFile("CLAUDE.md", file!);
    await store.snapshot({ name: "round-trip symlink" });

    expect(remoteTree).toContainEqual(
      expect.objectContaining({
        mode: "120000",
        path: ".vitehub/workspaces/docs/CLAUDE.md",
        sha: textSha("AGENTS.md"),
      }),
    );
  });

  it("preserves surrounding whitespace in GitHub symlink targets", async () => {
    const target = " AGENTS.md ";
    seedRemote(`.vitehub/workspaces/docs/${target}`, "# Agents\n");
    seedRemote(".vitehub/workspaces/docs/CLAUDE.md", target, "120000");
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

    await expect(store.stat("CLAUDE.md")).resolves.toMatchObject({
      metadata: { gitMode: "120000", symlinkTarget: target },
      path: "CLAUDE.md",
      type: "file",
    });
    const file = await store.readFile("CLAUDE.md");
    expect(file).toMatchObject({
      content: textBytes("# Agents\n"),
      metadata: { gitMode: "120000", symlinkTarget: target },
      path: "CLAUDE.md",
    });
    await store.writeFile("CLAUDE.md", file!);
    await store.snapshot({ name: "round-trip whitespace symlink" });

    expect(remoteTree).toContainEqual(
      expect.objectContaining({
        mode: "120000",
        path: ".vitehub/workspaces/docs/CLAUDE.md",
        sha: textSha(target),
      }),
    );
  });

  it("commits GitHub symlink metadata as tree mode 120000", async () => {
    seedRemote(".vitehub/workspaces/docs/CLAUDE.md", "AGENTS.md", "120000");
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

    await store.writeFile("CLAUDE.md", {
      path: "CLAUDE.md",
      content: "NEXT.md",
      metadata: { gitMode: "120000" },
    });
    await store.snapshot({ name: "retarget symlink" });

    expect(
      requests.find((request) => request.path.endsWith("/git/trees") && request.method === "POST")
        ?.body,
    ).toMatchObject({
      tree: expect.arrayContaining([
        {
          mode: "120000",
          path: ".vitehub/workspaces/docs/CLAUDE.md",
          sha: textSha("NEXT.md"),
          type: "blob",
        },
      ]),
    });
  });

  it("preserves remote executable file modes during unrelated snapshots", async () => {
    seedRemote(".vitehub/workspaces/docs/bin/tool.sh", "#!/bin/sh\n", "100755");
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

    await expect(store.stat("bin/tool.sh")).resolves.toMatchObject({
      metadata: { gitMode: "100755" },
    });
    await store.writeFile("notes.md", { path: "notes.md", content: "ok\n" });
    await store.snapshot({ name: "write note" });

    expect(
      requests.find((request) => request.path.endsWith("/git/trees") && request.method === "POST")
        ?.body,
    ).toMatchObject({
      tree: expect.not.arrayContaining([
        expect.objectContaining({ path: ".vitehub/workspaces/docs/bin/tool.sh" }),
      ]),
    });
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
