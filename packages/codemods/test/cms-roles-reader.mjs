import { parseAst } from "vite"

import { readCmsPresetUsage } from "../../cms/src/build.ts"

export function readCmsOptions(code, file, cwd) {
  return readCmsPresetUsage(code, file, cwd, parseAst)?.options
}
