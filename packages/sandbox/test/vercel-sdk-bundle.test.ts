import { build } from "esbuild";
import { resolve } from "node:path";

import { expect, it } from "vitest";

// Nitro output has no `node_modules`. The server bundler must see the SDK import, or the low-level Vercel runtime
// cannot load `@vercel/sandbox` after the build.
it("lets the server bundler see @vercel/sandbox from the low-level Vercel runtime", async () => {
  const result = await build({
    bundle: true,
    entryPoints: [resolve(import.meta.dirname, "../src/vercel.ts")],
    format: "esm",
    logLevel: "silent",
    metafile: true,
    outdir: "out",
    packages: "external",
    platform: "node",
    splitting: true,
    write: false,
  });
  const imports = Object.values(result.metafile.outputs).flatMap(output => output.imports);

  expect(imports).toContainEqual(expect.objectContaining({ external: true, path: "@vercel/sandbox" }));
});
