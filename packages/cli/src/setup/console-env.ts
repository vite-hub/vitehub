import { execFile } from "node:child_process"
import { mkdtemp, open, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { parseArgs } from "node:util"

import { cliErrorDiagnostics } from "../error-diagnostics.ts"
import { consoleOrigin, consoleUrlVariable, defaultConsoleUrl, readConsoleCredential } from "./console-auth.ts"
import { writeSetupError, writeSetupJson } from "./envelope.ts"

import type { ViteHubCliContext, ViteHubCliFeature } from "@vite-hub/internal/cli"

const pullUsage = "vitehub env pull --from console [--stage <name>] [--project <id>] [--console <url>] [--yes] [--json]"

const stagePattern = /^[a-z0-9][a-z0-9_-]{0,62}$/

/** One line of a `.env` file. A value that a parser could read in two ways goes in quotes. */
export function dotenvLine(name: string, value: string): string {
  if (/^[\w./:@+,-]*$/.test(value)) return `${name}=${value}`
  // dotenv keeps backslashes in single/backtick quotes; Vite expands dollars in every quote style.
  const escaped = value.replace(/\$/g, "\\$")
  const quote = ["'", "`", '"'].find(candidate => !value.includes(candidate) && (candidate !== '"' || !/\\[nr]/.test(value)))
  if (!quote || value.includes("\r")) throw cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] Cannot represent ${name} faithfully in a dotenv file. Use a value without carriage returns and with an available dotenv quote delimiter.` })
  return `${name}=${quote}${escaped}${quote}`
}

/** Run git in `cwd`. `undefined` when git is missing. */
function git(cwd: string, args: string[]): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, env: { ...process.env, LC_ALL: "C" } }, (error) => {
      if (!error) return resolve(0)
      const code: unknown = Reflect.get(error, "code")
      resolve(typeof code === "number" ? code : undefined)
    })
  })
}

/**
 * Git must not commit the file. In a repository, the file must be ignored and not tracked. Outside a repository, there is
 * nothing to commit it to.
 */
async function checkIgnored(cwd: string, file: string): Promise<void> {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"])
  if (inside !== 0) return
  if (await git(cwd, ["ls-files", "--error-unmatch", "--", file]) === 0) throw cliErrorDiagnostics.CLI_ENV_FILE_NOT_IGNORED({ file, tracked: true })
  if (await git(cwd, ["check-ignore", "-q", "--no-index", "--", file]) !== 0) throw cliErrorDiagnostics.CLI_ENV_FILE_NOT_IGNORED({ file, tracked: false })
}

interface PullValues {
  console?: string
  from?: string
  help: boolean
  json: boolean
  project?: string
  stage: string
  yes: boolean
}

function readPullArgs(args: string[]): PullValues {
  try {
    return parseArgs({
      args,
      options: {
        console: { type: "string" },
        from: { type: "string" },
        help: { default: false, short: "h", type: "boolean" },
        json: { default: false, type: "boolean" },
        project: { type: "string" },
        stage: { default: "production", type: "string" },
        yes: { default: false, short: "y", type: "boolean" },
      },
      strict: true,
    }).values as PullValues
  }
  catch (error: unknown) {
    throw cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] ${error instanceof Error ? error.message : String(error)} Usage: ${pullUsage}` })
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json().catch(() => ({}))
  return body instanceof Object ? body as Record<string, unknown> : {}
}

function consoleFailure(origin: string, path: string, status: number, body: Record<string, unknown>) {
  const why = typeof body.message === "string" ? body.message : `${origin} answered ${status} to ${path}.`
  // A code of the Console catalog carries its own fix, such as the key to add for CONSOLE_ENV_KEY_MISSING.
  const message = typeof body.fix === "string" ? `${why} ${body.fix}` : why
  return cliErrorDiagnostics.CLI_ENV_PULL_FAILED({ code: typeof body.code === "string" ? body.code : String(status), message })
}

/**
 * `vitehub env pull --from console`: write the values of one stage of a project from a self-hosted Console to
 * `.env.<stage>`, with mode 600. It refuses to replace a file without `--yes`, and refuses a file that git would commit.
 */
export const envPullFeature: ViteHubCliFeature = {
  description: "Write the env values of a stage from a self-hosted Console to .env.<stage>. Needs `vitehub login` and the owner or admin role.",
  name: "pull",
  usage: pullUsage,
  run: async (args, context: ViteHubCliContext) => {
    const json = args.includes("--json")
    try {
      const values = readPullArgs(args)
      if (values.help) {
        context.stdout.write(`Usage: ${pullUsage}\n\n${envPullFeature.description}\n`)
        return 0
      }
      if (values.from !== "console") throw cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] env pull reads values from a Console: pass --from console. Usage: ${pullUsage}` })
      if (!stagePattern.test(values.stage)) throw cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] --stage is lowercase letters, digits, "-", and "_", such as production. Got ${JSON.stringify(values.stage)}.` })
      const file = `.env.${values.stage}`
      const target = join(context.cwd, file)
      await checkIgnored(context.cwd, file)

      const credential = await readConsoleCredential(context.env, values.console)
      if (!credential) throw cliErrorDiagnostics.CLI_CONSOLE_SIGNED_OUT({ console: consoleOrigin(values.console ?? context.env[consoleUrlVariable] ?? defaultConsoleUrl) })
      const request = async (path: string, init: RequestInit = {}) => {
        const response = await (context.fetch ?? fetch)(`${credential.origin}${path}`, { ...init, headers: { accept: "application/json", authorization: `Bearer ${credential.token}`, ...(init.body ? { "content-type": "application/json" } : {}) } })
        if (response.status === 401) throw cliErrorDiagnostics.CLI_CONSOLE_SIGNED_OUT({ console: credential.origin })
        const body = await readJson(response)
        if (!response.ok) throw consoleFailure(credential.origin, path, response.status, body)
        return body
      }

      let project = values.project
      if (!project) {
        const listed = await request("/api/projects")
        const projects = Array.isArray(listed.projects) ? listed.projects as { id: string, url: string }[] : []
        if (projects.length !== 1) {
          const choices = projects.map(item => `${item.id} (${item.url})`).join(", ")
          throw cliErrorDiagnostics.CLI_R0003({ message: `[vitehub] The key opens ${projects.length} projects. Pass --project <id>${choices ? `: ${choices}` : ""}.` })
        }
        project = projects[0]!.id
      }

      const answer = await request(`/api/projects/${encodeURIComponent(project)}/env/${values.stage}/reveal`, { body: "{}", method: "POST" })
      const pulled = answer.values instanceof Object ? Object.entries(answer.values as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string") : []
      const text = `# Pulled from ${credential.origin}, project ${project}, stage ${values.stage}. Do not commit this file.\n${pulled.map(([name, value]) => dotenvLine(name, value)).join("\n")}\n`

      // Rename replaces the directory entry, never a symlink or hard-link target.
      const temporary = values.yes ? await mkdtemp(join(context.cwd, ".vitehub-env-")) : undefined
      try {
        const destination = temporary ? join(temporary, "values") : target
        const handle = await open(destination, "wx", 0o600).catch((error: unknown) => {
          if (error instanceof Error && Reflect.get(error, "code") === "EEXIST") throw cliErrorDiagnostics.CLI_ENV_FILE_EXISTS({ file })
          throw error
        })
        try {
          await handle.writeFile(text)
        }
        finally {
          await handle.close()
        }
        if (temporary) await rename(destination, target)
      }
      finally {
        if (temporary) await rm(temporary, { recursive: true, force: true })
      }

      const names = pulled.map(([name]) => name)
      if (json) writeSetupJson(context, { console: credential.origin, file, names, project, stage: values.stage })
      else context.stdout.write(`Wrote ${names.length} value${names.length === 1 ? "" : "s"} of ${values.stage} to ${file} (mode 600)${names.length ? `: ${names.join(", ")}` : ""}.\n`)
      return 0
    }
    catch (error: unknown) {
      return writeSetupError(context, json, error)
    }
  },
}
