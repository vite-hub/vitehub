import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { promisify } from "node:util"

const execute = promisify(execFile)

/** Keep invocation-owned files out of ordinary `git add -A` without changing the index content. */
export async function protectGeneratedProviderGitFiles(root: string, paths: readonly string[]): Promise<() => Promise<void>> {
  if (!paths.length) return async () => undefined
  const git = async (args: string[]) => (await execute("git", ["-C", root, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1" },
  })).stdout
  const top = (await git(["rev-parse", "--show-toplevel"])).trim()
  if (await realpath(top) !== await realpath(root)) throw new Error("Generated provider files require the pull request repository root.")
  const names = [...new Set(paths.map(path => relative(root, path).replaceAll("\\", "/")))]
  if (names.some(name => /[\r\n]/.test(name))) throw new Error("Generated provider Git paths must not contain line breaks.")
  const entries = (await git(["ls-files", "-v", "-z", "--", ...names])).split("\0").filter(Boolean)
  const trackedEntries = entries.filter(entry => entry[0]?.toUpperCase() !== "S")
  const originalSkipWorktree = new Map(trackedEntries.map(entry => [entry.slice(2), entry[0] === "S"]))
  const excludePath = resolve(root, (await git(["rev-parse", "--git-path", "info/exclude"])).trim())
  const originalExclude = await readFile(excludePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  const marker = `# vitehub generated provider files ${randomUUID()}`
  const escapePattern = (name: string) => name.replace(/[\\*?[\]#! ]/g, "\\$&")
  const block = `\n${marker}\n${names.map(name => `/${escapePattern(name)}`).join("\n")}\n${marker} end\n`
  let excluded = false
  const restore = async () => {
    try {
      for (const [name, skipWorktree] of originalSkipWorktree) {
        await git(["update-index", skipWorktree ? "--skip-worktree" : "--no-skip-worktree", "--", name])
      }
    }
    finally {
      if (excluded) {
        const currentExclude = await readFile(excludePath, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        })
        if (currentExclude === undefined) {
          if (originalExclude !== undefined) await writeFile(excludePath, originalExclude)
        }
        else if (currentExclude.includes(block)) {
          const withoutBlock = currentExclude.replace(block, "")
          if (withoutBlock.length) await writeFile(excludePath, withoutBlock)
          else await rm(excludePath, { force: true })
        }
        else if (originalExclude !== undefined) await writeFile(excludePath, originalExclude)
        else await rm(excludePath, { force: true })
        excluded = false
      }
    }
  }
  try {
    await mkdir(dirname(excludePath), { recursive: true })
    await writeFile(excludePath, `${originalExclude ?? ""}${block}`)
    excluded = true
    if (originalSkipWorktree.size) await git(["update-index", "--skip-worktree", "--", ...originalSkipWorktree.keys()])
    return restore
  }
  catch (error) {
    await restore()
    throw error
  }
}
