import { readFile, writeFile } from "node:fs/promises"
import { userInfo } from "node:os"
import { join, relative, resolve, sep } from "node:path"

import { formatter as poFormatter } from "@lingui/format-po"

import { inspectI18n } from "./inspect.ts"
import { findPreviousTranslations } from "./lineage.ts"
import { recordsRoot } from "./lingui.ts"
import { importTranslation, isVisible, removeRecord } from "./records.ts"

import type { CatalogType, LinguiConfigNormalized } from "@lingui/conf"
import type { ViteHubCliContext, ViteHubCliContributor } from "@vite-hub/internal/cli"
import type { I18nStatus } from "./inspect.ts"

/** Returns the Lingui config of the app in `rootDir`. The Vite plugin builds it from the `i18n` options. */
export type I18nConfigResolver = (rootDir: string) => LinguiConfigNormalized

interface Flags {
  help: boolean
  json: boolean
  yes: boolean
  by?: string
  output?: string
  positionals: string[]
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { help: false, json: false, yes: false, positionals: [] }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--help" || arg === "-h") flags.help = true
    else if (arg === "--json") flags.json = true
    else if (arg === "--yes" || arg === "-y") flags.yes = true
    else if (arg === "--output" || arg === "-o") flags.output = args[++index]
    else if (arg.startsWith("--output=")) flags.output = arg.slice("--output=".length)
    else if (arg === "--by") flags.by = args[++index]
    else if (arg.startsWith("--by=")) flags.by = arg.slice("--by=".length)
    else flags.positionals.push(arg)
  }
  return flags
}

function formatStatus(status: I18nStatus): string {
  const rows = status.locales.map((locale) => {
    const percent = locale.messages === 0 ? 100 : Math.round(locale.translated / locale.messages * 100)
    const role = locale.source
      ? "source"
      : `${percent}% translated, ${locale.missing} missing${locale.changed ? ` (${locale.changed} changed)` : ""}${locale.unused ? `, ${locale.unused} unused` : ""}  ${locale.folder}`
    return `${locale.locale.padEnd(8)} ${String(locale.messages).padStart(5)} messages  ${role}`
  })
  const problems = status.locales.flatMap(locale => locale.problems.map(problem => `  ${problem.file}: ${problem.problem}`))
  const unused = status.locales.some(locale => locale.unused > 0)
  const changed = status.locales.find(locale => locale.changed > 0)
  return [
    ...rows,
    ...(problems.length ? ["", "Records that ViteHub skips:", ...problems] : []),
    ...(changed ? ["", `A changed message keeps its old translation as a draft in \`vitehub i18n export ${changed.locale}\`. Review it, then import the file.`] : []),
    ...(unused ? ["", "Delete unused records with `vitehub i18n prune`."] : []),
    "",
  ].join("\n")
}

/**
 * How the records folder relates to the `i18n.workspace` Workspace: `vitehub pull` merges the published translations
 * of that Workspace into the folder when `vitehub.lock` checks it out there.
 */
async function workspaceNote(rootDir: string, folder: string, workspace: string | undefined): Promise<string[]> {
  if (!workspace) return []
  const dir = relative(rootDir, folder).split(sep).join("/") || "."
  let entry: unknown
  try {
    entry = Reflect.get(Object(Reflect.get(Object(JSON.parse(await readFile(join(rootDir, "vitehub.lock"), "utf8"))), "workspaces")), workspace)
  }
  catch {
    entry = undefined
  }
  const remote: unknown = Object(entry) === entry ? Reflect.get(Object(entry), "remote") : undefined
  const pull = `vitehub pull ${workspace} --dir ${dir} --ref published --url ${typeof remote === "string" && remote ? remote : "<origin>"}`
  if (Object(entry) === entry && Reflect.get(Object(entry), "dir") === dir) {
    const ref = String(Reflect.get(Object(entry), "ref"))
    if (ref === "published") return ["", `${dir}/ is a checkout of Workspace "${workspace}" (published). Run \`vitehub pull\` for translations saved since then.`]
    return ["", `Warning: ${dir}/ is a checkout of Workspace "${workspace}" on ref "${ref}", not "published". \`vitehub pull\` copies its unpublished translations into ${dir}/, and the next build embeds them. To switch, remove "${workspace}" from vitehub.lock, then run \`${pull}\`.`]
  }
  return ["", `Translations saved in Workspace "${workspace}" reach ${dir}/ only through a pull: \`${pull}\`.`]
}

function translationLocale(config: LinguiConfigNormalized, locale: string | undefined): string | undefined {
  return config.locales.find(entry => entry !== config.sourceLocale && entry.toLowerCase() === locale?.toLowerCase())
}

function usage(context: ViteHubCliContext, text: string, code = 0): number {
  ;(code ? context.stderr : context.stdout).write(`Usage: ${text}\n`)
  return code
}

const usages = {
  status: "vitehub i18n status [--json]",
  export: "vitehub i18n export <locale> [--output <file.po>]",
  import: "vitehub i18n import <locale> <file.po> [--by <login>] [--json]",
  prune: "vitehub i18n prune [--yes] [--json]",
}

const expectedComment = "vitehub-i18n-expected: "

function importBaseline(comments: string[] = []): string | null | undefined {
  const baselines = comments.filter(comment => comment.startsWith(expectedComment))
  // A PO file without an export baseline can add records, but cannot replace an existing translation.
  if (!baselines.length) return null
  if (baselines.length !== 1) return undefined
  try {
    const expected: unknown = JSON.parse(baselines[0]!.slice(expectedComment.length))
    return expected === null || typeof expected === "string" ? expected : undefined
  }
  catch {
    return undefined
  }
}

export function createI18nCliContributor(resolveConfig: I18nConfigResolver, workspace: () => string | undefined = () => undefined): ViteHubCliContributor {
  return {
    namespaces: [{
      name: "i18n",
      description: "Show translation coverage, and move translations to and from PO files.",
      defaultFeature: "status",
      features: [
        {
          name: "status",
          description: "Read the messages of the code and show how many each locale translates.",
          usage: usages.status,
          run: async (args, context) => {
            const flags = parseFlags(args)
            if (flags.help) return usage(context, usages.status)
            const config = resolveConfig(context.rootDir)
            const status = await inspectI18n(config)
            if (flags.json) {
              context.stdout.write(`${JSON.stringify(status.locales, null, 2)}\n`)
              return 0
            }
            context.stdout.write(formatStatus(status))
            const note = await workspaceNote(context.rootDir, recordsRoot(config.rootDir), workspace())
            if (note.length) context.stdout.write(`${note.join("\n").trimStart()}\n`)
            return 0
          },
        },
        {
          name: "export",
          description: "Write the messages and translations of one locale as a PO file, for Poedit or a translation service.",
          usage: usages.export,
          run: async (args, context) => {
            const flags = parseFlags(args)
            if (flags.help) return usage(context, usages.export)
            const config = resolveConfig(context.rootDir)
            const locale = translationLocale(config, flags.positionals[0])
            if (!locale) return usage(context, `${usages.export}\nThe locale must be one of: ${config.locales.filter(entry => entry !== config.sourceLocale).join(", ")}.`, 1)
            const status = await inspectI18n(config)
            const records = status.records[locale] ?? {}
            // A message whose source changed a little gets its old translation, marked fuzzy as gettext does, so a
            // translator edits it instead of starting again. `import` skips fuzzy entries.
            const previous = findPreviousTranslations(status.messages, records)
            const catalog: CatalogType = {}
            for (const [id, message] of Object.entries(status.messages)) {
              const carried = previous.get(id)
              catalog[id] = {
                message: message.message,
                ...(message.context ? { context: message.context } : {}),
                translation: records[id] && isVisible(records[id]) ? records[id].text : carried?.record.text ?? "",
                comments: [
                  ...message.comments ?? [],
                  `${expectedComment}${JSON.stringify(records[id]?.text ?? null)}`,
                  ...(carried ? [`Previous source: ${carried.record.source}`] : []),
                ],
                ...(carried ? { extra: { flags: ["fuzzy"] } } : {}),
                origin: message.origins.map((origin) => {
                  const index = origin.lastIndexOf(":")
                  return index === -1 ? [origin] : [origin.slice(0, index), Number(origin.slice(index + 1))]
                }),
              }
            }
            const file = flags.output ? resolve(context.cwd, flags.output) : `${locale}.po`
            const po = await poFormatter({ lineNumbers: true }).serialize(catalog, { locale, sourceLocale: config.sourceLocale, filename: file, existing: undefined })
            if (flags.output) {
              await writeFile(file, po)
              context.stderr.write(`Wrote ${Object.keys(catalog).length} messages to ${flags.output}.\n`)
            }
            else context.stdout.write(po)
            return 0
          },
        },
        {
          name: "import",
          description: "Save the translations of a PO file as records. Messages without a translation stay as they are, and a translation that loses a placeholder is refused.",
          usage: usages.import,
          run: async (args, context) => {
            const flags = parseFlags(args)
            if (flags.help) return usage(context, usages.import)
            const config = resolveConfig(context.rootDir)
            const locale = translationLocale(config, flags.positionals[0])
            const input = flags.positionals[1]
            if (!locale || !input) return usage(context, usages.import, 1)
            const file = resolve(context.cwd, input)
            const catalog = await poFormatter().parse(await readFile(file, "utf8"), { locale, sourceLocale: config.sourceLocale, filename: file })
            const root = recordsRoot(config.rootDir)
            const by = flags.by || userInfo().username
            const at = new Date().toISOString()
            let saved = 0
            let unchanged = 0
            let fuzzy = 0
            const refused: { message: string, problem: string }[] = []
            for (const entry of Object.values(catalog)) {
              if (!entry.message || !entry.translation) continue
              const flags = (entry.extra as { flags?: unknown } | undefined)?.flags
              if (Array.isArray(flags) && flags.includes("fuzzy")) {
                fuzzy++
                continue
              }
              const expected = importBaseline(entry.comments)
              if (expected === undefined) {
                refused.push({ message: entry.message, problem: "The PO export baseline is invalid. Export the locale again before editing it." })
                continue
              }
              const result = await importTranslation(root, locale, { message: entry.message, context: entry.context }, entry.translation, { by, at, expected })
              if (result.ok) saved++
              else if (result.code === "unchanged") unchanged++
              else refused.push({ message: entry.message, problem: result.message })
            }
            const lines = refused.map(entry => `  ${JSON.stringify(entry.message)}: ${entry.problem}`)
            const skipped = fuzzy ? ` Skipped ${fuzzy} fuzzy translations: remove the fuzzy flag after you review them.` : ""
            context.stdout.write(flags.json
              ? `${JSON.stringify({ locale, saved, unchanged, fuzzy, refused })}\n`
              : `Saved ${saved} translations to locales/${locale}. ${unchanged} were already saved.${skipped}\n${refused.length ? `Refused ${refused.length}:\n${lines.join("\n")}\n` : ""}`)
            return refused.length ? 1 : 0
          },
        },
        {
          name: "prune",
          description: "Delete the records of messages that the code no longer has. Lists them unless --yes. Export changed messages first: prune deletes their old translations.",
          usage: usages.prune,
          run: async (args, context) => {
            const flags = parseFlags(args)
            if (flags.help) return usage(context, usages.prune)
            const config = resolveConfig(context.rootDir)
            const status = await inspectI18n(config)
            const unused = Object.entries(status.records).flatMap(([locale, records]) =>
              Object.entries(records).filter(([id]) => !(id in status.messages)).map(([, record]) => ({ locale, hash: record.hash, source: record.source })))
            if (flags.yes) for (const record of unused) await removeRecord(recordsRoot(config.rootDir), record.locale, record.hash)
            if (flags.json) context.stdout.write(`${JSON.stringify({ deleted: flags.yes, records: unused })}\n`)
            else if (!unused.length) context.stdout.write("Every record belongs to a message in the code.\n")
            else {
              const lines = unused.map(record => `  ${record.locale}  ${JSON.stringify(record.source)}`)
              context.stdout.write(`${flags.yes ? "Deleted" : "Unused"} ${unused.length} records:\n${lines.join("\n")}\n${flags.yes ? "" : "Run `vitehub i18n prune --yes` to delete them.\n"}`)
            }
            return 0
          },
        },
      ],
    }],
  }
}
