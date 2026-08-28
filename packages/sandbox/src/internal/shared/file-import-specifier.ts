import { pathToFileURL } from 'node:url'

export function createFileImportSpecifier(
  file: string,
  platform: NodeJS.Platform = process.platform,
) {
  return pathToFileURL(file, { windows: platform === 'win32' }).href
}
