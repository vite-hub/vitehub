import { useWorkspace, type WorkspaceName } from "@vite-hub/workspace"
import { isWorkspaceName, useWorkspaceFiles } from "@vite-hub/workspace/files"

declare global {
  interface ViteHubWorkspaceNameMap {
    docs: true
  }
  interface ViteHubWorkspaceAssetMap {
    docs: "guide.md"
  }
}

declare const project: string
declare const titles: Record<WorkspaceName, string>
// @ts-expect-error An unchecked name is not a generated or validated name.
useWorkspaceFiles(project)
if (isWorkspaceName(project)) {
  useWorkspace(project).fs.readFile("runtime.txt")
  useWorkspaceFiles(project, { mode: "write" })
  // @ts-expect-error Runtime validation does not prove membership in the generated catalog.
  titles[project]
}
useWorkspaceFiles("docs").fs.readFile("guide.md")
// @ts-expect-error Literal Workspace names still infer generated asset paths.
useWorkspaceFiles("docs").fs.readFile("runtime.txt")
