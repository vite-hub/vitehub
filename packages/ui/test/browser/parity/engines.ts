import type { Component } from "vue";

// One line per engine. An engine has one fixture per component in its own folder (`./<engine>/<component>.vue`),
// and each fixture renders the accessible content that `scripts/<component>.mjs` describes.
export const engines: Record<string, Record<string, () => Promise<{ default: Component }>>> = {
  reka: import.meta.glob("./reka/*.vue"),
};
