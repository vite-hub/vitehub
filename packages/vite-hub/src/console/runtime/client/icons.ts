import { setCustomIconsLoader } from "@iconify/vue";

/**
 * Agent tools can declare any Lucide icon, and the Console CSP blocks the Iconify API.
 * The entry bundles only the icons that Console sources use. Load the full set when a page shows another one.
 */
export function deferLucideIcons(): void {
  setCustomIconsLoader(async () => (await import("@iconify-json/lucide/icons.json")).default, "lucide");
}
