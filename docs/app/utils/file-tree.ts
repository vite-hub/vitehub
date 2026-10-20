export type FileTreeFolderRow = { kind: "folder"; name: string; path: string; depth: number };
export type FileTreeFileRow = { kind: "file"; name: string; path: string; depth: number; index: number };
export type FileTreeRow = FileTreeFolderRow | FileTreeFileRow;

type Folder = { folders: Map<string, Folder>; files: { name: string; path: string; index: number }[] };

/**
 * Lays out file paths as an editor file tree: folders first, then files, each sorted by name.
 * `index` keeps the position of the path in the input, so callers can map a row back to its file.
 */
export function buildFileTree(paths: readonly string[]): FileTreeRow[] {
  const root: Folder = { folders: new Map(), files: [] };
  paths.forEach((path, index) => {
    const parts = path.split("/");
    const name = parts.pop() ?? path;
    let folder = root;
    for (const part of parts) {
      let child = folder.folders.get(part);
      if (!child) {
        child = { folders: new Map(), files: [] };
        folder.folders.set(part, child);
      }
      folder = child;
    }
    folder.files.push({ name, path, index });
  });

  const rows: FileTreeRow[] = [];
  const visit = (folder: Folder, depth: number, prefix: string) => {
    for (const [name, child] of [...folder.folders].sort(([left], [right]) => left.localeCompare(right))) {
      rows.push({ kind: "folder", name, path: `${prefix}${name}/`, depth });
      visit(child, depth + 1, `${prefix}${name}/`);
    }
    for (const file of [...folder.files].sort((left, right) => left.name.localeCompare(right.name))) {
      rows.push({ kind: "file", ...file, depth });
    }
  };
  visit(root, 0, "");
  return rows;
}
