import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  decodePlaygroundLink,
  encodePlaygroundLink,
  playgroundLinkLimit,
  playgroundUrl,
  readPlaygroundHash,
  zipFiles,
} from "../src/playground.ts";

const template = { id: "kv", files: { "package.json": "{}\n", "server/api/health.get.ts": "export default () => 'ok'\n", "tsconfig.json": "{}\n" } };

describe("playground links", () => {
  it("shares only the changes from the template, and restores them", async () => {
    const { "tsconfig.json": _removed, ...kept } = template.files;
    const files = { ...kept, "server/api/health.get.ts": "export default () => 'edited'\n", "server/api/new.get.ts": "export default () => 1\n" };
    const code = await encodePlaygroundLink({ template: "kv", files }, template.files);
    expect(code).toMatch(/^[\w-]+$/);
    // An unedited template is a short link.
    expect((await encodePlaygroundLink({ template: "kv", files: template.files }, template.files)).length).toBeLessThan(20);
    expect(readPlaygroundHash(playgroundUrl("/play", code).split("/play")[1]!)).toBe(code);
    expect(await decodePlaygroundLink(code, [template])).toEqual({ template: "kv", files });
  });

  it("shares files without a template", async () => {
    const files = { "content.md": "# Hello\n" };
    const code = await encodePlaygroundLink({ files });
    expect(await decodePlaygroundLink(code)).toEqual({ files });
  });

  it("rejects links that it cannot read", async () => {
    expect(await decodePlaygroundLink("not-a-code", [template])).toBeUndefined();
    expect(await decodePlaygroundLink(await encodePlaygroundLink({ template: "gone", files: {} }), [template])).toBeUndefined();
    expect(await decodePlaygroundLink(deflateRawSync("[]").toString("base64url"))).toBeUndefined();
    expect(readPlaygroundHash("#other=1")).toBeUndefined();
  });

  it("does not inflate a crafted link past its limit", async () => {
    const huge = await encodePlaygroundLink({ files: { "big.txt": "a".repeat(3 * 2 ** 20) } });
    // Highly repetitive data fits in a short link, so the limit is on the inflated size.
    expect(huge.length).toBeLessThan(playgroundLinkLimit);
    expect(await decodePlaygroundLink(huge)).toBeUndefined();
  });

  it.each(["../../outside.txt", "/outside.ts", "", ".", "..", "server/../outside.ts", "./file.ts", "server//file.ts", "server/", "server\\file.ts", "C:outside.ts", "\\\\?\\C:\\outside.ts", "bad\0.ts"])("rejects unsafe shared and ZIP paths: %j", async (path) => {
    expect(await decodePlaygroundLink(await encodePlaygroundLink({ files: { [path]: "unsafe" } }))).toBeUndefined();
    const deletion = deflateRawSync(JSON.stringify({ t: "kv", d: [path] })).toString("base64url");
    expect(await decodePlaygroundLink(deletion, [template])).toBeUndefined();
    expect(() => zipFiles({ [path]: "unsafe" }, "vitehub-kv")).toThrow("safe project-relative paths");
    expect(() => zipFiles({ "file.ts": "safe" }, path)).toThrow("safe project-relative paths");
  });
});

describe("zipFiles", () => {
  it("writes a zip that unzip reads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vitehub-playground-zip-"));
    try {
      const files = { "package.json": "{}\n", "server/api/é.get.ts": "export default () => 'ü'\n" };
      // The archive identifies a Unix creator, preventing Ubuntu's UnZip from converting UTF-8 names as DOS names.
      const zip = zipFiles(files, "vitehub-kv");
      const directoryOffset = new DataView(zip.buffer).getUint32(zip.length - 6, true);
      expect(zip[directoryOffset + 5]).toBe(3);
      await writeFile(join(dir, "app.zip"), zip);
      execFileSync("unzip", ["-q", "app.zip"], { cwd: dir });
      expect(await readFile(join(dir, "vitehub-kv/server/api/é.get.ts"), "utf8")).toBe(files["server/api/é.get.ts"]);
      expect(await readFile(join(dir, "vitehub-kv/package.json"), "utf8")).toBe("{}\n");
      // The same files give the same bytes.
      expect(zipFiles(files, "a")).toEqual(zipFiles({ ...files }, "a"));
    }
    finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
