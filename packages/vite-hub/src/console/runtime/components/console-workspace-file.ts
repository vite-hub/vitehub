export interface ConsoleWorkspaceFileIdentity {
  path: string;
  revision: string;
}

export function matchesWorkspaceFile(
  file: ConsoleWorkspaceFileIdentity,
  path: string,
  workspace?: { revision: string },
): boolean {
  return file.path === path && (!workspace || file.revision === workspace.revision);
}
