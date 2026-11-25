import { setTimeout as sleep } from "node:timers/promises"

import { checkConsoleApp, checkProblem, consoleAppUrl, linkConsoleApp, listConsoleApps, openConsole } from "../console-apps.ts"
import { readConsoleCredential } from "../console-auth.ts"

import type { DeploymentEnvEntry } from "@vite-hub/internal/build/deployment-plan-output"
import type { ViteHubCliContext } from "@vite-hub/internal/cli"
import type { ConsoleApp, ConsoleClient } from "../console-apps.ts"

const consoleKeyPrefix = "VITEHUB_CONSOLE_KEY_"
const checkDelays = [1000, 2000, 4000]

/** What `vitehub deploy --json` prints in `console` after it linked the app. */
export interface DeployConsoleOutput {
  /** The Console origin. */
  console: string
  /** The id of the app in the Console. */
  app: string
  /** The Console page of the app. */
  url: string
  /** True when this deploy linked the app. False when the Console had it. */
  created: boolean
  /** The key variable that this deploy set on the host. Missing when the host had it. */
  keySet?: string
  /** True when the app answered a signed request of the Console. */
  linked: boolean
  /** Why the app did not answer, such as `401 CONSOLE_KEY_UNKNOWN: ...`. Only when `linked` is false. */
  problem?: string
}

export interface DeployConsole {
  client: ConsoleClient
  apps: ConsoleApp[]
  /** The key of each app of the team, by variable name. */
  keys: Record<string, string>
}

/** True when the build reads `VITEHUB_CONSOLE_KEY_<NAME>`, which `console: true` adds. */
export function readsConsoleKey(entries: readonly DeploymentEnvEntry[]): boolean {
  return entries.some(entry => entry.prefix === consoleKeyPrefix)
}

export function withoutConsoleKey(entries: readonly DeploymentEnvEntry[]): DeploymentEnvEntry[] {
  return entries.filter(entry => entry.prefix !== consoleKeyPrefix)
}

/**
 * The Console of the saved login, with the apps of its team. Without a login it returns nothing, and deploy works as
 * before. When the Console fails, it warns and returns nothing, so a Console problem never stops a deploy.
 */
export async function openDeployConsole(context: ViteHubCliContext): Promise<DeployConsole | undefined> {
  if (!await readConsoleCredential(context.env)) return
  try {
    const client = await openConsole(context)
    const apps = await listConsoleApps(client)
    const keys = Object.fromEntries(apps.flatMap(app => app.keyVariable && app.publicKey ? [[app.keyVariable, app.publicKey]] : []))
    return { apps, client, keys }
  }
  catch (error: unknown) {
    context.stderr.write(`Warning: deploy does not link the app in the Console, because the Console failed: ${errorMessage(error)}\n`)
  }
}

/**
 * Links the deployed app in the Console, sets its key on the host when the host lacks it, and checks that the app
 * answers a signed request. The app of a key that the host has is this app, so deploy keeps that link when the URL
 * changed, such as a new custom domain.
 */
export async function linkDeployedApp(options: {
  console: DeployConsole
  url: string
  label: string
  onHost: ReadonlySet<string>
  setKey: (name: string, value: string) => Promise<void>
  context: ViteHubCliContext
}): Promise<DeployConsoleOutput | undefined> {
  const { client } = options.console
  try {
    const known = options.console.apps.find(app => app.keyVariable && options.onHost.has(app.keyVariable))
    const { app, created } = known ? { app: known, created: false } : await linkConsoleApp(client, { label: options.label, url: options.url })
    const keySet = app.keyVariable && app.publicKey && !options.onHost.has(app.keyVariable) ? app.keyVariable : undefined
    if (keySet && app.publicKey) await options.setKey(keySet, app.publicKey)
    let check = await checkConsoleApp(client, app.id)
    for (const delay of checkDelays) {
      if (check.linked) break
      await sleep(delay)
      check = await checkConsoleApp(client, app.id)
    }
    return { app: app.id, console: client.origin, created, ...(keySet ? { keySet } : {}), linked: check.linked, ...(check.linked ? {} : { problem: checkProblem(check) }), url: consoleAppUrl(client.origin, app) }
  }
  catch (error: unknown) {
    options.context.stderr.write(`Warning: the app is deployed, but deploy could not link it in the Console: ${errorMessage(error)} Run \`vitehub apps link ${options.url}\`.\n`)
  }
}

export function formatDeployConsole(output: DeployConsoleOutput): string {
  const lines = [
    ...(output.created ? [`Linked the app in ${output.console} as ${output.app}.`] : []),
    ...(output.keySet ? [`Set ${output.keySet} on the host.`] : []),
    output.linked ? `Console: ${output.url}` : `The app does not accept the Console yet: ${output.problem ?? "no answer"}. Run \`vitehub apps check ${output.app}\`.`,
  ]
  return `${lines.join("\n")}\n`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
