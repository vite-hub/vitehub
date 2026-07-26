import { execFile } from "node:child_process"
import { access } from "node:fs/promises"
import { isAbsolute, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { resolveModuleURL } from "exsolve"

const execFileAsync = promisify(execFile)

export async function verifyBuiltPackageExports(
  packageRootURL: URL,
  packageName: string,
  subpaths: readonly string[],
): Promise<void> {
  const packageRoot = fileURLToPath(packageRootURL)
  const distRoot = join(packageRoot, "dist")
  for (const subpath of subpaths) {
    const specifier = subpath === "." ? packageName : `${packageName}/${subpath.replace(/^\.\//, "")}`
    const resolved = resolveModuleURL(specifier, { from: packageRootURL })
    const target = fileURLToPath(resolved)
    const relativeTarget = relative(distRoot, target)

    if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
      throw new Error(`${specifier} resolved outside ${distRoot}: ${resolved}`)
    }

    await access(target)
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(resolved)})`])
  }
}
