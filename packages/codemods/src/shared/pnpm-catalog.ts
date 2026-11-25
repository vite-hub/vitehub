import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { parseDocument } from "yaml"

function catalogEntry(value: unknown, key: string): unknown {
  return value instanceof Map ? value.get(key) : undefined
}

export async function readPnpmCatalogVersion(cwd: string, name: string, catalog: string): Promise<string | undefined> {
  let directory = cwd
  while (!existsSync(join(directory, "pnpm-workspace.yaml"))) {
    if (dirname(directory) === directory) return
    directory = dirname(directory)
  }
  const document = parseDocument(await readFile(join(directory, "pnpm-workspace.yaml"), "utf8"))
  const workspace: unknown = document.toJS({ mapAsMap: true })
  const fallback = catalog === "default" ? catalogEntry(catalogEntry(workspace, "catalog"), name) : undefined
  const named = catalogEntry(catalogEntry(workspace, "catalogs"), catalog)
  const version = catalogEntry(named, name) ?? fallback
  if (typeof version === "string") return version
}
