import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { listCommandFiles } from "../src/internal/file-listing.ts";

const execFileAsync = promisify(execFile);

function listingFailure(result: { stderr: string }) {
  return new Error(result.stderr);
}

describe("command-backed Sandbox file listing", () => {
  it("owns recursive traversal, entry types, ordering, and literal paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-listing-"));
    const directory = join(root, "with 'quote");
    const file = join(directory, "with\ttab\nand newline");
    await mkdir(join(directory, "nested"), { recursive: true });
    await writeFile(file, "payload");
    await writeFile(join(directory, "nested", "child"), "child");
    await symlink(file, join(directory, "link"));
    const run = async (options: { abortSignal?: AbortSignal; command: string }) => {
      const result = await execFileAsync("sh", ["-c", options.command], { signal: options.abortSignal });
      return { ...result, exitCode: 0 };
    };
    try {
      const listed = await listCommandFiles(run, { path: directory }, listingFailure);
      expect(listed).toEqual([
        { path: join(directory, "link"), size: undefined, type: "symlink" },
        { path: join(directory, "nested"), size: undefined, type: "directory" },
        { path: file, size: 7, type: "file" },
      ].sort((left, right) => left.path.localeCompare(right.path)));
      const recursive = await listCommandFiles(run, { path: directory, recursive: true }, listingFailure);
      expect(recursive).toContainEqual({ path: join(directory, "nested", "child"), size: 5, type: "file" });
      expect(recursive.map(entry => entry.path)).toEqual(recursive.map(entry => entry.path).toSorted((left, right) => left.localeCompare(right)));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps transport failures and cancellation at the adapter seam", async () => {
    const failure = new Error("provider listing failure");
    await expect(listCommandFiles(
      async () => ({ exitCode: 1, stderr: "denied", stdout: "" }),
      { path: "/workspace" },
      () => failure,
    )).rejects.toBe(failure);
    const reason = new Error("cancel listing");
    await expect(listCommandFiles(
      async () => { throw new Error("must not execute"); },
      { abortSignal: AbortSignal.abort(reason), path: "/workspace" },
      listingFailure,
    )).rejects.toBe(reason);
  });

  it("rejects incomplete transport records", async () => {
    await expect(listCommandFiles(
      async () => ({ exitCode: 0, stderr: "", stdout: "invalid\0" }),
      { path: "/workspace" },
      listingFailure,
    )).rejects.toThrow("invalid file entry");
  });
});
