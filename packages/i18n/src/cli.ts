import { extractMessages, inspectI18n } from "./inspect.ts"

import type { LinguiConfigNormalized } from "@lingui/conf"
import type { ViteHubCliContext, ViteHubCliContributor } from "@vite-hub/internal/cli"
import type { I18nLocaleStatus } from "./inspect.ts"

/** Returns the Lingui config of the app in `rootDir`. The Vite plugin builds it from the `i18n` options. */
export type I18nConfigResolver = (rootDir: string) => LinguiConfigNormalized

function formatStatus(statuses: I18nLocaleStatus[]): string {
  const rows = statuses.map((status) => {
    const percent = status.messages === 0 ? 100 : Math.round(status.translated / status.messages * 100)
    const role = status.source ? "source" : `${percent}% translated, ${status.missing} missing`
    return `${status.locale.padEnd(8)} ${String(status.messages).padStart(5)} messages  ${role}  ${status.catalog}`
  })
  return `${rows.join("\n")}\n`
}

function parseFlags(args: string[]): { json: boolean, help: boolean, keep: boolean } {
  return { json: args.includes("--json"), help: args.includes("--help") || args.includes("-h"), keep: args.includes("--keep-obsolete") }
}

export function createI18nCliContributor(resolveConfig: I18nConfigResolver): ViteHubCliContributor {
  return {
    namespaces: [{
      name: "i18n",
      description: "Collect messages into PO catalogs and show translation coverage.",
      defaultFeature: "status",
      features: [
        {
          name: "extract",
          description: "Collect the messages of the code into locales/<locale>.po. Translations stay.",
          usage: "vitehub i18n extract [--keep-obsolete] [--json]",
          run: async (args: string[], context: ViteHubCliContext) => {
            const flags = parseFlags(args)
            if (flags.help) {
              context.stdout.write("Usage: vitehub i18n extract [--keep-obsolete] [--json]\n")
              return 0
            }
            const statuses = await extractMessages(resolveConfig(context.rootDir), { clean: !flags.keep })
            context.stdout.write(flags.json ? `${JSON.stringify(statuses, null, 2)}\n` : formatStatus(statuses))
            return 0
          },
        },
        {
          name: "status",
          description: "Show how many messages each locale translates.",
          usage: "vitehub i18n status [--json]",
          run: async (args: string[], context: ViteHubCliContext) => {
            const flags = parseFlags(args)
            if (flags.help) {
              context.stdout.write("Usage: vitehub i18n status [--json]\n")
              return 0
            }
            const statuses = await inspectI18n(resolveConfig(context.rootDir))
            context.stdout.write(flags.json ? `${JSON.stringify(statuses, null, 2)}\n` : formatStatus(statuses))
            return 0
          },
        },
      ],
    }],
  }
}
