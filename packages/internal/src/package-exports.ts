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
          return [key, { ...value, require: value.require ?? value.import, default: value.default ?? value.import }];
        }
        return [key, value];
      }

      if (!value.startsWith("./dist/") || !value.endsWith(".js")) return [key, value];

      return [
        key,
        {
          types: value.replace(/\.js$/, ".d.ts"),
          import: value,
          require: value,
          default: value,
        },
      ];
    }),
  );
}
