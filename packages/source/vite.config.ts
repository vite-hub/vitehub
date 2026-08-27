import { createRequire } from "node:module";

import { defineConfig } from "vite-plus";

const require = createRequire(import.meta.url);
const requireFromTinyglobby = createRequire(require.resolve("tinyglobby"));
const fdirEntry = requireFromTinyglobby.resolve("fdir");

export default defineConfig({
  pack: {
    alias: {
      // fdir's ESM entry resolves its optional picomatch peer through createRequire.
      // Bundle the CJS entry so the package output can inline that dependency instead.
      fdir: fdirEntry,
    },
    plugins: [{
      name: "source-fdir-without-optional-glob",
      transform(code, id) {
        if (id !== fdirEntry) return;

        const optionalPicomatch = `let pm = null;
/* c8 ignore next 6 */
try {
	require.resolve("picomatch");
	pm = require("picomatch");
} catch {}`;

        if (!code.includes(optionalPicomatch)) {
          throw new Error("The fdir optional picomatch probe changed");
        }

        return code.replace(optionalPicomatch, "let pm = null;");
      },
    }],
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: [
        /^@modelcontextprotocol\/sdk(?:\/|$)/,
        /^@vite-hub\/internal/,
        "effect",
        "fdir",
        "mrmime",
        "ocache",
        "picomatch",
        "tinyglobby",
      ],
    },
    entry: [
      "src/client.ts",
      "src/content.ts",
      "src/content/client.ts",
      "src/index.ts",
      "src/file.ts",
      "src/github.ts",
      "src/glob.ts",
      "src/markdown.ts",
      "src/mcp.ts",
      "src/server.ts",
    ],
    exports: {
      customExports(exports) {
        return Object.fromEntries(
          Object.entries(exports).map(([key, value]) => {
            if (String(value) !== value || !value.endsWith(".js")) {
              return [key, value];
            }
            return [
              key,
              {
                types: value.replace(/\.js$/, ".d.ts"),
                import: value,
              },
            ];
          }),
        );
      },
      inlinedDependencies: false,
    },
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
  },
});
