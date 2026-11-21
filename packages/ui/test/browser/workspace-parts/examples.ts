// The examples of section 1 of the prototype, in its two groups, for the bar and start fixtures.
import type { WorkspaceExample } from "../../../src/workspace/workspace-examples.ts";

const files = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`src/file-${index}.ts`, ""]));

export const examples: WorkspaceExample[] = [
  { description: "A greeting translated to Spanish and German.", files: files(6), group: "Source language", id: "vue", label: "Vue" },
  { description: "The same app, written in JSX.", files: files(6), group: "Source language", id: "react", label: "React" },
  { description: "The same app, written in Svelte 5.", files: files(6), group: "Source language", id: "svelte", label: "Svelte" },
  { description: "Counts that read right in every locale.", files: files(5), group: "Recipes", id: "plurals", label: "Plurals" },
  { description: "What shows before a translation exists.", files: files(5), group: "Recipes", id: "fallbacks", label: "Fallbacks" },
];

/** The prototype shows dark mode with `.dark` on `<html>`: `?theme=dark`. */
export function theme(params: URLSearchParams): void {
  document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
}
