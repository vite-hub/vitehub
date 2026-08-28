import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("Workspace build aliases", () => {
  it("converts the Vercel fetch shim URL to a Windows filesystem path", async () => {
    const source = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
    const alias = fileURLToPath(
      new URL("file:///D:/a/vitehub/vitehub/packages/workspace/src/internal/vercel-fetch.ts"),
      { windows: true },
    );

    expect(source).toContain(
      'fileURLToPath(new URL("./src/internal/vercel-fetch.ts", import.meta.url))',
    );
    expect(source).not.toContain(
      'new URL("./src/internal/vercel-fetch.ts", import.meta.url).pathname',
    );
    expect(alias).toBe(
      "D:\\a\\vitehub\\vitehub\\packages\\workspace\\src\\internal\\vercel-fetch.ts",
    );
  });
});
