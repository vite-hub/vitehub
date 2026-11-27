type PackageExportValue = string | Record<string, unknown>;

export function normalizePackageExports(
  exports: Record<string, PackageExportValue>,
): Record<string, PackageExportValue> {
  return Object.fromEntries(
    Object.entries(exports).map(([key, value]) => {
      if (typeof value !== "string") {
        if (
          value &&
          typeof value.import === "string" &&
          value.import.startsWith("./dist/") &&
          value.import.endsWith(".js")
        ) {
          return [key, { ...value, default: value.default ?? value.import }];
        }
        return [key, value];
      }

      if (!value.startsWith("./dist/") || !value.endsWith(".js")) return [key, value];

      return [
        key,
        {
          types: value.replace(/\.js$/, ".d.ts"),
          import: value,
          default: value,
        },
      ];
    }),
  );
}

/**
 * The browsers that ViteHub supports, as build targets: the latest two Chrome and Firefox releases and the current and
 * previous Safari major ("Native first" in AGENTS.md). Use it for a script that a page loads as it is, with no bundler
 * of the app between, such as the page pill. Package code that an app bundles keeps the app's own target.
 * Raise it with the support floor. A stale target only transforms more syntax than it must.
 */
export const browserTarget: string[] = ["chrome157", "firefox159", "safari27.1"];

/** Pack options that every published package shares. Spread them first, so the package's own options win. */
export const packDefaults = {
  tsconfig: "tsconfig.build.json",
  exports: {
    customExports: normalizePackageExports,
    inlinedDependencies: false,
  },
  outExtensions: () => ({ dts: ".d.ts", js: ".js" }),
  publint: "ci-only",
} as const;
