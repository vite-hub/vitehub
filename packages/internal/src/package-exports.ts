type PackageExportValue = string | Record<string, unknown>;

export function normalizePackageExports(
  exports: Record<string, PackageExportValue>,
): Record<string, PackageExportValue> {
  return Object.fromEntries(
    Object.entries(exports).map(([key, value]) => {
      if (typeof value !== "string" || !value.startsWith("./dist/") || !value.endsWith(".js")) {
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
}
