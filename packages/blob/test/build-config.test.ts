import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("Blob build aliases", () => {
  it("converts Vercel shim URLs to Windows filesystem paths", async () => {
    const source = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
    const alias = fileURLToPath(
      new URL("file:///D:/a/vitehub/vitehub/packages/blob/src/internal/vercel-fetch.ts"),
      { windows: true },
    );

    for (const shim of ["oidc", "retry", "is-buffer", "throttle", "fetch"]) {
      expect(source).toContain(
        `fileURLToPath(new URL("./src/internal/vercel-${shim}.ts", import.meta.url))`,
      );
    }
    expect(source).not.toContain("import.meta.url).pathname");
    expect(alias).toBe("D:\\a\\vitehub\\vitehub\\packages\\blob\\src\\internal\\vercel-fetch.ts");
  });
});
