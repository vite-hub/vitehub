import { stubLanding } from "./stub";
import type { PrimitiveLanding } from "./types";

const workspace = stubLanding("workspace", "Workspace", "/docs/workspace");

export const WorkspaceLanding = {
  ...workspace,
  eyebrow: "ViteHub Workspace",
  description: "Give every Agent a persistent file tree with explicit access and predictable state.",
  tagline: "A persistent file tree for work that needs to continue.",
  accent: "info",
  supported: ["Vite", "Nitro", "Nuxt"],
  variants: workspace.variants.map((variant) => ({
    ...variant,
    files: [
      ...variant.files.slice(0, 2),
      {
        path: "server/workspaces/notes.ts",
        language: "typescript",
        content: `import { defineWorkspace } from "@vite-hub/workspace"

export default defineWorkspace({
  // Persist on a host with a writable, durable filesystem.
  store: { provider: "local", root: ".vitehub/workspaces/notes" },
})`,
      },
      {
        path: "server/notes.ts",
        language: "typescript",
        content: `import { useWorkspace } from "@vite-hub/workspace"

export async function saveNote(text: string) {
  const workspace = useWorkspace("notes", { mode: "write" })
  await workspace.fs.writeFile("note.md", text, {
    mediaType: "text/markdown",
  })
}

export async function readNote() {
  const workspace = useWorkspace("notes")
  return workspace.fs.readFile("note.md", { encoding: "utf8" })
}`,
      },
    ],
  })),
} satisfies PrimitiveLanding;
