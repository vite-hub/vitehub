import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import { defineConfig } from "vite-plus";

const require = createRequire(import.meta.url);
const requireFromTinyglobby = createRequire(require.resolve("tinyglobby"));
const fdirEntry = resolve(
  dirname(requireFromTinyglobby.resolve("fdir/package.json")),
  "dist/index.mjs",
);

export default defineConfig({
  pack: {
    alias: {
      // Transform the ESM entry below so Workers never receive its optional createRequire probe.
      fdir: fdirEntry,
    },
    plugins: [
      {
        name: "source-fdir-without-optional-glob",
        transform(code, id) {
          if (id !== fdirEntry) return;

          const optionalPicomatch = `let pm = null;
/* c8 ignore next 6 */
try {
	__require.resolve("picomatch");
	pm = __require("picomatch");
} catch {}`;

          if (!code.includes(optionalPicomatch)) {
            throw new Error("The fdir optional picomatch probe changed");
          }

          return code.replace(optionalPicomatch, "let pm = null;");
        },
      },
    ],
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
      "src/vite.ts",
    ],
    exports: {
      customExports(exports) {
        return {
          ...Object.fromEntries(Object.entries(exports).map(([key, value]) => {
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
          })),
          "./tsconfig": "./tsconfig.vite.json",
        };
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
