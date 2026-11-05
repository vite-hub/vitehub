import { addCollection, setCustomIconsLoader } from "@iconify/vue";
import { icons } from "@vite-hub/icons";

/**
 * Agent tools can declare any Lucide icon, and the Console CSP blocks the Iconify API.
 * The entry bundles only the icons that Console sources use. Load the full set when a page shows another one.
 */
export function deferLucideIcons(): void {
  setCustomIconsLoader(async () => (await import("@iconify-json/lucide/icons.json")).default, "lucide");
}

/** Bundles the ViteHub set, so `i-vitehub-*` section icons of the Console and of owner packages resolve offline. */
export function addViteHubIcons(): void {
  addCollection(icons);
}
