import { existsSync } from "node:fs"
import { join } from "node:path"

export const workspaceSuffixPattern = /\.workspace\.(?:c|m)?[jt]s$/i
export const workspaceConfigPattern = /^config\.(?:c|m)?[jt]s$/i
export const workspaceAgentPattern = /^agent\.(?:c|m)?[jt]s$/i
export const declarationFilePattern = /\.d\.(?:c|m)?[jt]s$/i
export const workspaceConfigFileNames = ["config.ts", "config.mts", "config.cts", "config.js", "config.mjs", "config.cjs"] as const

export function hasWorkspaceDirectoryConfig(directory: string): boolean {
  return workspaceConfigFileNames.some(file => existsSync(join(directory, file)))
}

export function isWorkspaceAssetFile(name: string): boolean {
  return !workspaceConfigPattern.test(name) && !workspaceAgentPattern.test(name) && !declarationFilePattern.test(name)
}
