import type { ChatDevtoolsFileTreeItem } from "../../../src/chat-shared.js"

export type FileRow = ChatDevtoolsFileTreeItem & { depth: number, expanded?: boolean }
export type SourceRootState = NonNullable<ChatDevtoolsFileTreeItem["status"]>

function isSyntheticRoot(file: ChatDevtoolsFileTreeItem) {
  return file.kind === "directory" && (file.path === "" || file.path === "/")
}

function sourceRootState(file: ChatDevtoolsFileTreeItem): SourceRootState | undefined {
  if (file.kind !== "directory" || !file.source) return undefined
  return file.status
}

export function sourceRootStates(files: ChatDevtoolsFileTreeItem[]): Map<string, SourceRootState> {
  const states = new Map<string, SourceRootState>()
  const pending = [...files]
  while (pending.length) {
    const file = pending.shift()!
    const state = sourceRootState(file)
    if (state) {
      states.set(file.path, state)
    }
    pending.push(...(file.children || []))
  }
  return states
}

export function syncExpandedFilePaths(
  files: ChatDevtoolsFileTreeItem[],
  current: ReadonlySet<string>,
  previousSourceRootStates: ReadonlyMap<string, SourceRootState> = new Map(),
) {
  const expanded = new Set(current)
  const roots = files.filter(isSyntheticRoot)

  if (roots.length === 1) {
    expanded.add(roots[0]!.path)
  }

  for (const [path, state] of sourceRootStates(files)) {
    const previousState = previousSourceRootStates.get(path)
    if (state === "ready" && previousState !== undefined && previousState !== "ready") {
      expanded.add(path)
    }
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
