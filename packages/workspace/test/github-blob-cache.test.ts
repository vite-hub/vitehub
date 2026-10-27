import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { baseSha, createFakeGitHub, textBytes, textSha } from "./fake-github.ts";

let fake: ReturnType<typeof createFakeGitHub>;

beforeEach(() => {
  vi.resetModules();
  fake = createFakeGitHub();
  vi.stubGlobal("fetch", vi.fn(fake.fetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function store(repository = "onmax/repo") {
  const { createGitHubWorkspaceStore } = await import("../src/providers/github/store.ts");
  return createGitHubWorkspaceStore(
    { provider: "github", repository, token: "token", root: "docs" },
    "docs",
  );
}

function blobRequests() {
  return fake.requests.filter((request) => request.path.includes("/git/blobs/"));
}

async function readBytes(current: Awaited<ReturnType<typeof store>>, path: string) {
  const content = (await current.readFile(path))?.content;
  if (!(content instanceof Uint8Array)) throw new Error(`Expected bytes for ${path}`);
  return content;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("reads each blob once across GitHub store instances", async () => {
  const files = new Map([
    ["a.md", "# A"],
    ["b.md", "# B"],
    ["c.md", "# C"],
  ]);
  for (const [path, text] of files) fake.seed(`docs/${path}`, text);

  for (let index = 0; index < 2; index++) {
    const current = await store();
    expect((await current.list()).map((entry) => entry.path)).toEqual([...files.keys()]);
    for (const [path, text] of files) {
      expect((await current.readFile(path))?.content).toEqual(textBytes(text));
    }
  }

  expect(blobRequests()).toHaveLength(3);
});

it("coalesces concurrent reads across stores", async () => {
  fake.seed("docs/a.md", "shared");
  const first = await store();
  const second = await store();
  const files = await Promise.all([first.readFile("a.md"), second.readFile("a.md")]);

  expect(files.map((file) => file?.content)).toEqual([textBytes("shared"), textBytes("shared")]);
  expect(files[0]?.content).not.toBe(files[1]?.content);
  expect(blobRequests()).toHaveLength(1);
});

it("keeps cached bytes private from store and history callers", async () => {
  fake.seed("docs/a.md", "original");
  const first = await store();
  const bytes = await readBytes(first, "a.md");
  expect(bytes).toEqual(textBytes("original"));
  bytes.fill(0);

  const second = await store();
  const cached = await readBytes(second, "a.md");
  expect(cached).toEqual(textBytes("original"));
  cached.fill(1);

  const view = await second.history!.open(baseSha);
  const historyBytes = await view.readFile("a.md", { encoding: "binary" });
  expect(historyBytes).toEqual(textBytes("original"));
  historyBytes.fill(2);
  await expect(view.readFile("a.md")).resolves.toBe("original");
  expect(blobRequests()).toHaveLength(1);
});

it("reuses blobs across repositories", async () => {
  fake.seed("docs/a.md", "same bytes");
  await (await store()).readFile("a.md");

  const other = createFakeGitHub({ owner: "other", repo: "docs" });
  other.seed("docs/renamed.md", "same bytes");
  vi.stubGlobal("fetch", vi.fn(other.fetch));
  expect((await (await store("other/docs")).readFile("renamed.md"))?.content).toEqual(
    textBytes("same bytes"),
  );
  expect(other.requests.filter((request) => request.path.includes("/git/blobs/"))).toHaveLength(0);
});

it.each(["repository", "credentials"])("isolates pending blob failures by %s", async (scope) => {
  fake.seed("docs/a.md", "shared");
  const other = createFakeGitHub({ owner: "other", repo: "docs" });
  other.seed("docs/a.md", "shared");
  const started = deferred();
  const release = deferred();
  fake.respond((request) =>
    request.path.includes("/git/blobs/") && request.headers.get("authorization") === "Bearer restricted"
      ? new Response("forbidden", { status: 403 })
      : undefined,
  );
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const api = url.pathname.startsWith("/repos/other/docs/") ? other : fake;
    const response = await api.fetch(input, init);
    if (response.status === 403) {
      started.resolve();
      await release.promise;
    }
    return response;
  }));
  const { connectGitHubRepository, readGitHubFile } =
    await import("../src/providers/github/shared.ts");
  const entry = { mode: "100644", path: "docs/a.md", sha: textSha("shared") } as const;
  const restricted = connectGitHubRepository("onmax/repo", "restricted");
  const accessible = connectGitHubRepository(
    scope === "repository" ? "other/docs" : "onmax/repo",
    scope === "repository" ? "restricted" : "valid",
  );
  const failed = readGitHubFile(restricted, entry, baseSha);
  const rejection = expect(failed).rejects.toThrow("403");
  await started.promise;
  const successful = readGitHubFile(accessible, entry, baseSha);
  const success = expect(successful).resolves.toEqual(textBytes("shared"));
  release.resolve();
  await Promise.all([rejection, success]);

  // Successful bytes remain reusable even from the scope whose request failed.
  await expect(readGitHubFile(restricted, entry, baseSha)).resolves.toEqual(textBytes("shared"));
  expect([...fake.requests, ...other.requests].filter((request) => request.path.includes("/git/blobs/"))).toHaveLength(2);
});

it("fetches changed blobs while history retains the old bytes", async () => {
  fake.seed("docs/a.md", "before");
  await (await store()).readFile("a.md");
  fake.commit("main", { "docs/a.md": "after" });

  const current = await store();
  expect((await current.readFile("a.md"))?.content).toEqual(textBytes("after"));
  const view = await current.history!.open(baseSha);
  await expect(view.readFile("a.md")).resolves.toBe("before");
  expect(blobRequests()).toHaveLength(2);
});

it.each(["http", "malformed"])("retries a blob after a shared %s failure", async (failure) => {
  fake.seed("docs/a.md", "retry");
  let failed = true;
  fake.respond((request) =>
    failed && request.path.includes("/git/blobs/")
      ? failure === "http"
        ? new Response("forbidden", { status: 403 })
        : Response.json({ encoding: "base64" })
      : undefined,
  );
  const first = await store();
  const second = await store();
  const results = await Promise.allSettled([first.readFile("a.md"), second.readFile("a.md")]);
  expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  expect(blobRequests()).toHaveLength(1);

  failed = false;
  expect((await first.readFile("a.md"))?.content).toEqual(textBytes("retry"));
  expect((await second.readFile("a.md"))?.content).toEqual(textBytes("retry"));
  expect(blobRequests()).toHaveLength(2);
});

it("does not retain blobs larger than 4 MiB", async () => {
  const bytes = new Uint8Array(4 * 1024 * 1024 + 1).fill(7);
  fake.seed("docs/large.bin", bytes);
  for (let index = 0; index < 2; index++) {
    const content = await readBytes(await store(), "large.bin");
    expect(content.byteLength).toBe(bytes.byteLength);
    expect(content.at(-1)).toBe(7);
  }
  expect(blobRequests()).toHaveLength(2);
});

it.each([false, true])("evicts the oldest blobs at 32 MiB with concurrent scopes: %s", async (concurrentScopes) => {
  for (let index = 0; index < 9; index++) {
    fake.seed(`docs/${index}.bin`, new Uint8Array(4 * 1024 * 1024).fill(index));
  }
  if (concurrentScopes) {
    const { connectGitHubRepository, readGitHubFile } =
      await import("../src/providers/github/shared.ts");
    const entry = fake.tree().find((file) => file.path === "docs/0.bin")!;
    await Promise.all(["first", "second"].map((token) =>
      readGitHubFile(connectGitHubRepository("onmax/repo", token), { ...entry, mode: "100644" }, baseSha),
    ));
    expect(blobRequests()).toHaveLength(2);
  }
  const extraRequest = concurrentScopes ? 1 : 0;
  for (let index = 0; index < 8; index++) await (await store()).readFile(`${index}.bin`);
  await (await store()).readFile("0.bin");
  expect(blobRequests()).toHaveLength(8 + extraRequest);

  await (await store()).readFile("8.bin");
  await (await store()).readFile("1.bin");
  expect(blobRequests()).toHaveLength(9 + extraRequest);
  const evicted = await readBytes(await store(), "0.bin");
  expect(evicted.byteLength).toBe(4 * 1024 * 1024);
  expect(evicted.at(-1)).toBe(0);
  expect(blobRequests()).toHaveLength(10 + extraRequest);
});

it("rejects an already aborted read even when the blob is cached", async () => {
  fake.seed("docs/a.md", "abort");
  const { connectGitHubRepository, readGitHubFile } =
    await import("../src/providers/github/shared.ts");
  const repository = connectGitHubRepository("onmax/repo", "token");
  const entry = { mode: "100644", path: "docs/a.md", sha: textSha("abort") } as const;
  const signal = AbortSignal.abort();
  await expect(readGitHubFile(repository, entry, baseSha, signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(blobRequests()).toHaveLength(0);

  await (await store()).readFile("a.md");
  await expect(readGitHubFile(repository, entry, baseSha, signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(blobRequests()).toHaveLength(1);
});

it("cancels one caller without cancelling a shared blob download", async () => {
  fake.seed("docs/a.md", "shared abort");
  const started = deferred();
  const release = deferred();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const response = await fake.fetch(input, init);
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname.includes("/git/blobs/")) {
        started.resolve();
        await release.promise;
      }
      return response;
    }),
  );
  const { connectGitHubRepository, readGitHubFile } =
    await import("../src/providers/github/shared.ts");
  const abort = new AbortController();
  const cancelled = readGitHubFile(
    connectGitHubRepository("onmax/repo", "token"),
    {
      mode: "100644",
      path: "docs/a.md",
      sha: textSha("shared abort"),
    },
    baseSha,
    abort.signal,
  );
  const rejection = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  await started.promise;
  const current = await store();
  await current.list();
  const surviving = current.readFile("a.md");
  abort.abort();
  await rejection;
  release.resolve();

  expect((await surviving)?.content).toEqual(textBytes("shared abort"));
  expect((await (await store()).readFile("a.md"))?.content).toEqual(textBytes("shared abort"));
  expect(blobRequests()).toHaveLength(1);
});
