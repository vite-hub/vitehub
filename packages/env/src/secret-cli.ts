import { randomBytes } from "node:crypto"

import { consolePrivateKeyPrefix, consolePublicKeyPrefix, createConsoleKeyPair, isConsoleKeyName } from "@vite-hub/internal/console-signature"
import { deriveViteHubSecret, readViteHubSecret, viteHubSecretMinimumLength } from "@vite-hub/internal/secret"

import type { ViteHubCliFeature } from "@vite-hub/internal/cli"

interface SecretCliContext {
  env: Readonly<Record<string, string | undefined>>
  stderr: { write: (chunk: string) => unknown }
  stdout: { write: (chunk: string) => unknown }
}

interface SecretCliFeature {
  description: string
  name: string
  run: (args: string[], context: SecretCliContext) => Promise<number>
  usage: string
}

const generateUsage = "vitehub secret generate"
const deriveUsage = "vitehub secret derive <purpose>"
const consoleKeyUsage = "vitehub secret console-key [name]"

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
      "Print the secret that deriveSecret(<purpose>) returns for VITEHUB_SECRET.",
      "For example, `vitehub secret derive myapp:webhooks` prints the same key on every machine with the same root secret.",
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

/**
 * Print a new Ed25519 key pair for signed Console requests: the public key line for the app, and the private key line
 * for the machine or CI job that calls it with `--url`. The name defaults to `CLI`.
 */
async function consoleKey(args: string[], context: Pick<SecretCliContext, "stderr" | "stdout">): Promise<number> {
  if (help(args)) {
    context.stdout.write([
      `Usage: ${consoleKeyUsage}`,
      "",
      "Print a new key pair for signed Console requests. Set the first line on the app (console: { auth: \"token\" }),",
      "and the second line where the CLI runs, such as a CI secret. The name defaults to CLI.",
      "",
    ].join("\n"))
    return 0
  }
  const [input = "CLI", ...rest] = args
  const name = input.toUpperCase().replace(/[^A-Z0-9]+/g, "_")
  if (rest.length || !isConsoleKeyName(name)) {
    context.stderr.write(`Usage: ${consoleKeyUsage}\nThe name has 1 to 64 letters, digits, or underscores.\n`)
    return 1
  }
  const { privateKey, publicKey } = await createConsoleKeyPair()
  context.stdout.write([
    "# The app: set this variable on the deployment.",
    `${consolePublicKeyPrefix}${name}=${publicKey}`,
    "# The CLI: keep this one secret, such as in a CI secret. Remove the app variable to revoke it.",
    `${consolePrivateKeyPrefix}${name}=${privateKey}`,
    "",
  ].join("\n"))
  return 0
}

/** `vitehub secret` features. They read only the process env and never load the project. */
export const secretCliFeatures: SecretCliFeature[] = [
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
  {
    description: "Print a new key pair for signed Console requests from the CLI.",
    name: "console-key",
    run: async (args: string[], context: SecretCliContext) => await consoleKey(args, context),
    usage: consoleKeyUsage,
  },
] satisfies ViteHubCliFeature[]
