import { readFileSync } from "node:fs";

function exportKeys(source: string): string[] {
  const manifest: unknown = JSON.parse(source);
  if (manifest === null || typeof manifest !== "object" || !("exports" in manifest)) throw new TypeError("The manifest has no exports.");
  const { exports } = manifest;
  if (exports === null || typeof exports !== "object") throw new TypeError("The manifest exports are not a map.");
  return Object.keys(exports);
}

/** The part entries of `@vite-hub/kit`: every subpath except the Nuxt module, the styles, and the manifest. */
export const kitEntries: string[] = exportKeys(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  .filter((subpath) => subpath !== "./nuxt" && subpath !== "./package.json" && !subpath.startsWith("./styles/"))
  .map((subpath) => subpath.slice(2));

/** The entries of `@ui-sdk/vue`, read from its published manifest. */
export const uiSdkEntries: string[] = exportKeys(readFileSync(new URL(import.meta.resolve("@ui-sdk/vue/package.json")), "utf8"))
  .filter((subpath) => subpath !== "." && subpath !== "./nuxt" && subpath !== "./package.json")
  .map((subpath) => subpath.slice(2));

/** The entries the kit adds to ui-sdk's: components that ui-sdk does not have. */
export const ownEntries: string[] = ["form", "tags-input"];
