import { randomBytes } from "node:crypto"

import { deriveViteHubSecret, readViteHubSecret, viteHubSecretMinimumLength } from "@vite-hub/internal/secret"

import type { ViteHubCliFeature } from "@vite-hub/internal/cli"

interface SecretCliContext {
  env: Readonly<Record<string, string | undefined>>
  stderr: { write: (chunk: string) => unknown }
  stdout: { write: (chunk: string) => unknown }
}

const generateUsage = "vitehub secret generate"
const deriveUsage = "vitehub secret derive <purpose>"

function help(args: string[]): boolean {
  return args.includes("-h") || args.includes("--help")
}

function generate(args: string[], context: Pick<SecretCliContext, "stderr" | "stdout">): number {
  if (help(args)) {
    context.stdout.write(`Usage: ${generateUsage}\n\nPrint a new random root secret for VITEHUB_SECRET.\n`)
    return 0
  }
  if (args.length) {
    context.stderr.write(`Unexpected secret generate argument: ${args[0]}\n`)
    return 1
  }
  context.stdout.write(`${randomBytes(32).toString("base64")}\n`)
  return 0
}

async function derive(args: string[], context: SecretCliContext): Promise<number> {
  if (help(args)) {
    context.stdout.write([
      `Usage: ${deriveUsage}`,
      "",
      "Print the secret that deriveSecret(<purpose>) returns for VITEHUB_SECRET (or NUXT_APP_SECRET).",
      "For example, `vitehub secret derive vitehub:dispatch` prints the VITEHUB_DISPATCH_KEY of a deployment.",
      "",
    ].join("\n"))
    return 0
  }
  const [purpose, ...rest] = args
  if (!purpose || rest.length) {
    context.stderr.write(`Usage: ${deriveUsage}\n`)
    return 1
  }
  const root = readViteHubSecret(context.env)
  if (!root) {
    context.stderr.write("Set VITEHUB_SECRET to the root secret of the deployment.\n")
    return 1
  }
  if (root.length < viteHubSecretMinimumLength) {
    context.stderr.write(`VITEHUB_SECRET must be at least ${viteHubSecretMinimumLength} characters.\n`)
    return 1
  }
  context.stdout.write(`${await deriveViteHubSecret(root, purpose)}\n`)
  return 0
}

/** `vitehub secret` features. They read only the process env and never load the project. */
export const secretCliFeatures = [
  {
    description: "Print a new random root secret for VITEHUB_SECRET.",
    name: "generate",
    run: async (args: string[], context: SecretCliContext) => generate(args, context),
    usage: generateUsage,
  },
  {
    description: "Print the secret derived from VITEHUB_SECRET for one purpose.",
    name: "derive",
    run: async (args: string[], context: SecretCliContext) => await derive(args, context),
    usage: deriveUsage,
  },
] satisfies ViteHubCliFeature[]
