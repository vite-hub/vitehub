import { readFileSync } from "node:fs"

import { createSourceScanner } from "@vite-hub/internal/source-scanner"

import type { DiscoveredScheduleDefinition } from "../types.ts"
import { scheduleErrorDiagnostics } from "../error-diagnostics.ts"

const cronFieldPattern = /^[*,/\-0-9]+$/

export function validateProviderCron(cron: string, scheduleName: string): void {
  const fields = cron.trim().split(/\s+/)
  const hasVercelDayConflict = fields[2] !== "*" && fields[4] !== "*"
  if (fields.length !== 5 || !fields.every(field => cronFieldPattern.test(field)) || hasVercelDayConflict) {
    throw scheduleErrorDiagnostics.SCHEDULE_R0003({ message: `Schedule "${scheduleName}" uses cron "${cron}", but provider wake output only supports five-field UTC cron syntax compatible with Cloudflare, Vercel, and Netlify.` })
  }
}

function readStaticScheduleCron(file: string, scheduleName: string): string {
  const { findDefaultExportCall, readObjectProperty } = createSourceScanner(file)
  const source = readFileSync(file, "utf8")
  const definition = findDefaultExportCall(source, ["defineSchedule"], { positionalOptionsIndex: 2 })
  const cron = definition && readStaticString(definition.arguments.length > 1 ? definition.arguments[0] : readObjectProperty(definition.argument, "cron"))
  if (!cron) {
    throw scheduleErrorDiagnostics.SCHEDULE_R0004({ message: `Schedule "${scheduleName}" must declare a static cron string for provider wake output.` })
  }
  return cron
}

function readStaticString(source: string | undefined): string | undefined {
  if (!source || !/^["'`]/.test(source)) return
  const quote = source[0]
  let value = ""
  for (let index = 1; index < source.length; index++) {
    if (source[index] === "\\") value += source[++index] || ""
    else if (source[index] === quote) return source.slice(index + 1).trim() ? undefined : value
    else value += source[index]
  }
}

export async function readDefinitionCrons(definitions: DiscoveredScheduleDefinition[]) {
  const crons = await readRuntimeDefinitionCrons(definitions)
  for (const [name, cron] of crons) validateProviderCron(cron, name)
  return crons
}

export async function readRuntimeDefinitionCrons(definitions: DiscoveredScheduleDefinition[]) {
  const crons = new Map<string, string>()
  for (const definition of definitions) {
    const cron = readStaticScheduleCron(definition.handler, definition.name)
    crons.set(definition.name, cron)
  }
  return crons
}
