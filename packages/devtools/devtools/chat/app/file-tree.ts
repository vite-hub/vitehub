import type { ChatDevtoolsFileTreeItem } from "../../../src/chat-shared.js"

export type FileRow = ChatDevtoolsFileTreeItem & { depth: number, expanded?: boolean }

function isSyntheticRoot(file: ChatDevtoolsFileTreeItem) {
  return file.kind === "directory" && (file.path === "" || file.path === "/")
}

export function syncExpandedFilePaths(files: ChatDevtoolsFileTreeItem[], current: ReadonlySet<string>) {
  const expanded = new Set(current)
  const roots = files.filter(isSyntheticRoot)

  if (roots.length === 1) {
    expanded.add(roots[0]!.path)
  }

  return expanded
}

export function flattenFiles(files: ChatDevtoolsFileTreeItem[], expanded: ReadonlySet<string>, depth = 0): FileRow[] {
  return files.flatMap((file) => {
    const isExpanded = file.kind === "directory" && expanded.has(file.path)
    return [
      { ...file, depth, expanded: isExpanded },
      ...(isExpanded ? flattenFiles(file.children || [], expanded, depth + 1) : []),
    ]
  })
}
