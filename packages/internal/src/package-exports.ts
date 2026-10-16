type PackageExportValue = string | Record<string, unknown>;

export function normalizePackageExports(
  exports: Record<string, PackageExportValue>,
): Record<string, PackageExportValue> {
  return Object.fromEntries(
    Object.entries(exports).map(([key, value]) => {
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Package export values are an untagged string-or-condition object union at this manifest boundary.
      if (typeof value !== "string") {
        if (
          value &&
          // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Export condition fields are untrusted manifest values and must be narrowed before string operations.
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
