import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  createSourceFile,
  forEachChild,
  isBlock,
  isCallExpression,
  isElementAccessExpression,
  isFunctionLike,
  isIdentifier,
  isPropertyAccessExpression,
  isRegularExpressionLiteral,
  isSourceFile,
  isStringLiteralLike,
  isVariableDeclaration,
  type Identifier,
  type Node,
  type SourceFile,
  ScriptTarget,
} from "typescript"
import { describe, expect, it } from "vitest"

/**
 * Provider error contract. Provider, driver, and provision code must not decide what a failure means from its
 * message. Read the failure kind from `@vite-hub/internal/provider-failure`, a provider code, or an SDK error class.
 *
 * The scan covers `packages/*\/src` TypeScript files under a `providers/` or `drivers/` folder, and files whose
 * name has `provision`, `cloudflare`, `vercel`, or `netlify`. `packages/agent` and `packages/content` are not scanned.
 * It fails on:
 *
 * - `<value>.message.includes(...)`, `.match(...)`, `.startsWith(...)`, `.endsWith(...)`, or `.search(...)`.
 * - `/regex/.test(...)` or `.exec(...)`, or `<name>.test(...)` with a name that ends in `re`, `regex`, `pattern`, or
 *   `retryable`, when an argument reads `.message`, or a variable named `message` or `messages` that is set from a
 *   `.message` read. A parameter named `message`, such as a commit message, does not count.
 *
 * A site that has no other signal keeps the match with `// provider-message-match: <reason>` on the line above.
 */

const repoRoot = resolve(import.meta.dirname, "..")
const allowMarker = /provider-message-match:\s*(\S.*)?$/
const stringMethods = new Set(["endsWith", "includes", "match", "search", "startsWith"])
const regexName = /(?:^|[a-z_])(?:re|regex|pattern|retryable)$/i

interface MessageMatch {
  allowed: boolean
  file: string
  line: number
  text: string
}

function isProviderFile(file: string): boolean {
  if (!/^packages\/[^/]+\/src\/.+\.[cm]?tsx?$/.test(file) || file.endsWith(".d.ts")) return false
  if (file.startsWith("packages/agent/") || file.startsWith("packages/content/")) return false
  const name = file.slice(file.lastIndexOf("/") + 1)
  return /\/(?:providers|drivers)\//.test(file) || /provision|cloudflare|vercel|netlify/i.test(name)
}

/** `x.message`, `x["message"]`, or `Reflect.get(x, "message")`. */
function isMessageRead(node: Node): boolean {
  if (isPropertyAccessExpression(node)) return node.name.text === "message"
  if (isElementAccessExpression(node)) return isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === "message"
  return isCallExpression(node) && node.expression.getText() === "Reflect.get"
    && node.arguments[1] !== undefined && isStringLiteralLike(node.arguments[1]) && node.arguments[1].text === "message"
}

function readsMessageProperty(node: Node): boolean {
  if (isMessageRead(node)) return true
  return forEachChild(node, readsMessageProperty) ?? false
}

/** True when a variable with this name, in a function that holds the use, is set from a `.message` read. */
function isMessageVariable(use: Identifier): boolean {
  for (let scope: Node | undefined = use.parent; scope; scope = scope.parent) {
    if (!isFunctionLike(scope)) continue
    let found = false
    const visit = (node: Node) => {
      if (found) return
      if (isVariableDeclaration(node) && isIdentifier(node.name) && node.name.text === use.text && node.initializer && readsMessageProperty(node.initializer)) found = true
      else forEachChild(node, visit)
    }
    visit(scope)
    if (found) return true
  }
  return false
}

function readsMessage(node: Node): boolean {
  if (isMessageRead(node)) return true
  if (isIdentifier(node) && /^messages?$/i.test(node.text) && isMessageVariable(node)) return true
  return forEachChild(node, readsMessage) ?? false
}

function isRegexReceiver(node: Node): boolean {
  if (isRegularExpressionLiteral(node)) return true
  return isIdentifier(node) && regexName.test(node.text)
}

/** True when the line above the call, or above a node that holds it inside the same block, has an allow reason. */
function isAllowed(sourceFile: SourceFile, lines: readonly string[], node: Node): boolean {
  for (let current: Node = node; !isBlock(current) && !isSourceFile(current); current = current.parent) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(current.getStart(sourceFile))
    if (allowMarker.exec(lines[line - 1] ?? "")?.[1]?.trim()) return true
  }
  return false
}

function messageMatches(file: string, source: string): MessageMatch[] {
  const sourceFile = createSourceFile(file, source, ScriptTarget.Latest, true)
  const lines = source.split("\n")
  const matches: MessageMatch[] = []
  const visit = (node: Node) => {
    if (isCallExpression(node) && isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      const receiver = node.expression.expression
      const onMessage = stringMethods.has(method) && isPropertyAccessExpression(receiver) && receiver.name.text === "message"
      const regexOnMessage = (method === "test" || method === "exec") && isRegexReceiver(receiver) && node.arguments.some(readsMessage)
      if (onMessage || regexOnMessage) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        matches.push({ allowed: isAllowed(sourceFile, lines, node), file, line: line + 1, text: node.getText(sourceFile).replace(/\s+/g, " ").slice(0, 120) })
      }
    }
    forEachChild(node, visit)
  }
  visit(sourceFile)
  return matches
}

async function providerFileMatches(): Promise<MessageMatch[]> {
  const matches: MessageMatch[] = []
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "packages"], { cwd: repoRoot, encoding: "utf8" })
  for (const file of tracked.split("\0")) {
    if (!isProviderFile(file)) continue
    const path = resolve(repoRoot, file)
    const source = existsSync(path) ? readFileSync(path, "utf8") : execFileSync("git", ["show", `:${file}`], { cwd: repoRoot, encoding: "utf8" })
    matches.push(...messageMatches(file, source))
  }
  return matches
}

describe("provider error contract", () => {
  it("finds no message matching in provider, driver, and provision code", async () => {
    const found = (await providerFileMatches()).filter(match => !match.allowed).map(match => `${match.file}:${match.line} ${match.text}`)
    expect(found, "Match the failure kind from @vite-hub/internal/provider-failure, a provider code, or an SDK error class. Keep a match only with `// provider-message-match: <reason>` on the line above.").toEqual([])
  }, 30_000)

  it.each([
    ["error.message.includes(\"(10039)\")", "if (!error.message.includes(\"(10039)\")) throw error"],
    ["error.message.match(/exists/)", "const exists = error.message.match(/exists/)"],
    ["/already exists/i.test(error.message)", "const exists = /already exists/i.test(error.message)"],
    ["retryable.test(message)", "function retry(error: Error) {\n  const message = error.message\n  if (!retryable.test(message)) throw error\n}"],
    ["pattern.test(message)", "function missing(error: object) {\n  const message: unknown = Reflect.get(error, \"message\")\n  return typeof message === \"string\" && pattern.test(message)\n}"],
    ["MISSING_RE.test([error.message, cause.message].join(\"\\n\"))", "if (MISSING_RE.test([error.message, cause.message].join(\"\\n\"))) return"],
  ])("detects %s", (text, source) => {
    expect(messageMatches("packages/blob/src/drivers/a.ts", source)).toMatchObject([{ allowed: false, file: "packages/blob/src/drivers/a.ts", text }])
  })

  it.each([
    ["a code check", "if (error.kind !== \"conflict\") throw error"],
    ["a path check", "if (/^\\/tmp\\//.test(root)) throw error"],
    ["an SDK class", "if (error instanceof BlobNotFoundError) return null"],
    ["a non-message string", "if (key.includes(\"/\")) return"],
    ["a commit message parameter", "function read(message: string) { return trailerPattern.exec(message) }"],
  ])("ignores %s", (_name, source) => {
    expect(messageMatches("packages/blob/src/drivers/a.ts", source)).toEqual([])
  })

  it("accepts a match with a reason on the line above", () => {
    const source = "try {} catch (error) {\n  // provider-message-match: the R2 binding has no code property.\n  if (!range || !error.message.includes(\"(10039)\")) throw error\n}"
    expect(messageMatches("packages/blob/src/drivers/a.ts", source)).toMatchObject([{ allowed: true }])
  })

  it("rejects an allow comment without a reason", () => {
    const source = "// provider-message-match:\nif (!error.message.includes(\"(10039)\")) throw error"
    expect(messageMatches("packages/blob/src/drivers/a.ts", source)).toMatchObject([{ allowed: false }])
  })

  it("scans only provider code", () => {
    expect(isProviderFile("packages/blob/src/drivers/vercel-bundled.ts")).toBe(true)
    expect(isProviderFile("packages/kv/src/provision.ts")).toBe(true)
    expect(isProviderFile("packages/sandbox/src/internal/cloudflare-transport.ts")).toBe(true)
    expect(isProviderFile("packages/workspace/src/providers/vercel/blob-store.ts")).toBe(true)
    expect(isProviderFile("packages/workspace/src/core/errors.ts")).toBe(false)
    expect(isProviderFile("packages/agent/src/providers/codex.ts")).toBe(false)
    expect(isProviderFile("packages/blob/test/drivers/a.ts")).toBe(false)
  })
})
