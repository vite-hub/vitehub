import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  createSourceFile,
  forEachChild,
  isAsExpression,
  isAwaitExpression,
  isBinaryExpression,
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  isNonNullExpression,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isStringLiteralLike,
  isTemplateExpression,
  isTypeOfExpression,
  isVoidExpression,
  type Expression,
  type Node,
  ScriptTarget,
  SyntaxKind,
} from "typescript"
import { describe, expect, it } from "vitest"

/**
 * Grant contract. A check that guards a sensitive action must return a grant that the action requires
 * (`@vite-hub/runtime/internal/grant`). This test fails on four known "check here, act there" shapes in
 * `packages/*\/src` TypeScript files:
 *
 * 1. `admin-literal`: `admin: true` in an object literal outside `packages/env`. Only Env creates administrator access.
 * 2. `secret-compare`: a `===`, `!==`, `==`, or `!=` comparison that reads a credential with a plain comparison.
 *    Heuristic: one side names a secret, token, signature, or state value (an identifier, property, or call name that
 *    is `secret`, `token`, `signature`, or `state`, or ends in `Secret`, `Token`, `Signature`, or `State`, also inside a
 *    template literal), and the comparison reads a request or expected credential: an `authorization` value, a cookie,
 *    a `Bearer …` template, an `expected…` value, or a `read…Token` or `read…Secret` call. Comparisons with a literal or
 *    `typeof` are ignored. Code inside string literals, for example generated host output, is not parsed.
 * 3. `response-guard`: an exported function in Auth or Console server code with a guard name (`check`, `verify`,
 *    `require`, `guard`, `authorize`, `assert`, `ensure`, or `protect`) whose declared return type is
 *    `Response | undefined` or `Promise<Response | undefined>`. A caller can ignore `undefined` and act anyway.
 * 4. `symbol-for-capability`: `Symbol.for("vitehub.…")` whose last name segment says that it reaches a privileged
 *    object: it ends in `Target`, `Override`, `Grant`, `Authority`, `Capability`, `Approve`, `Approval`, `Verifier`,
 *    or `Materializer`. Any code can create the same key with `Symbol.for()`.
 */

const repoRoot = resolve(import.meta.dirname, "..")

type GrantRule = "admin-literal" | "response-guard" | "secret-compare" | "symbol-for-capability"

interface GrantFinding {
  file: string
  pattern: string
  rule: GrantRule
}

type GrantException = GrantFinding & ({ pr: number, reason?: undefined } | { pr?: undefined, reason: string })

/**
 * Known shapes on main. An entry with `pr` is removed by that open PR. An entry with `reason` has no open PR.
 * The test fails when an entry no longer matches the source, so remove the entry in the PR that removes the shape.
 */
const exceptions: readonly GrantException[] = [
  { file: "packages/agent/src/access-runtime.ts", pattern: "Symbol.for(\"vitehub.agent.workspaceOverride\")", reason: "Follow-up: no open PR replaces this key yet.", rule: "symbol-for-capability" },
  { file: "packages/agent/src/internal/channel-delivery.ts", pattern: "Symbol.for(\"vitehub.agent.channel-delivery-ownership-verifier\")", reason: "Follow-up: no open PR replaces this key yet.", rule: "symbol-for-capability" },
  { file: "packages/workspace/src/storage/materialization.ts", pattern: "Symbol.for(\"vitehub.workspace.revisionMaterializer\")", reason: "Follow-up: no open PR replaces this key yet.", rule: "symbol-for-capability" },
  { file: "packages/workspace/src/storage/target.ts", pattern: "Symbol.for(\"vitehub.workspace.storeTarget\")", reason: "Follow-up: no open PR replaces this key yet.", rule: "symbol-for-capability" },
  { file: "packages/auth/src/server.ts", pattern: "requireAuthAccessRoutes", reason: "Access-route middleware. It runs before the host route handler and cannot pass a grant to it.", rule: "response-guard" },
  { file: "packages/vite-hub/src/console/auth-cloudflare-access.ts", pattern: "verifyCloudflareAccessConsoleRequest", reason: "Console access policy check. Only withConsoleAccess() reads it and turns success into a grant.", rule: "response-guard" },
]

const credentialName = /^(?:secret|token|signature|state)$|(?:Secret|Token|Signature|State)$/
const credentialSource = /^(?:authorization|cookies?|expected[A-Z]\w*|read\w*(?:Token|Secret))$/
const guardName = /^(?:check|verify|require|guard|authorize|assert|ensure|protect)[A-Z]/
const responseGuardTypes = new Set(["Response|undefined", "undefined|Response", "Promise<Response|undefined>", "Promise<undefined|Response>"])
const capabilityKey = /(?:target|override|grant|authority|capability|approve|approval|verifier|materializer)$/i
const comparisonOperators = new Set([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
])

function unwrap(node: Expression): Expression {
  let current = node
  while (isParenthesizedExpression(current) || isAsExpression(current) || isSatisfiesExpression(current) || isNonNullExpression(current) || isAwaitExpression(current)) {
    current = current.expression
  }
  return current
}

function isLiteralOperand(node: Expression): boolean {
  const value = unwrap(node)
  return isStringLiteralLike(value) || isNumericLiteral(value) || isTypeOfExpression(value) || isVoidExpression(value)
    || value.kind === SyntaxKind.NullKeyword || value.kind === SyntaxKind.TrueKeyword || value.kind === SyntaxKind.FalseKeyword
    || (isIdentifier(value) && value.text === "undefined")
}

/** Names that an operand reads: the identifier, the last property, the called function, or template parts. */
function operandNames(node: Expression): string[] {
  const value = unwrap(node)
  if (isIdentifier(value)) return [value.text]
  if (isPropertyAccessExpression(value)) return [value.name.text]
  if (isCallExpression(value)) return operandNames(value.expression)
  if (isTemplateExpression(value)) return value.templateSpans.flatMap(span => operandNames(span.expression))
  return []
}

function readsCredentialSource(node: Node): boolean {
  if (isIdentifier(node) && credentialSource.test(node.text)) return true
  if ((isTemplateExpression(node) && node.head.text.startsWith("Bearer ")) || (isNoSubstitutionTemplateLiteral(node) && node.text.startsWith("Bearer "))) return true
  return forEachChild(node, readsCredentialSource) ?? false
}

function isResponseGuardOwner(file: string): boolean {
  return file.startsWith("packages/auth/src/") || file.startsWith("packages/vite-hub/src/console/")
}

function normalized(node: Node): string {
  return node.getText().replace(/\s+/g, " ")
}

function grantFindings(file: string, source: string): GrantFinding[] {
  const sourceFile = createSourceFile(file, source, ScriptTarget.Latest, true)
  const findings: GrantFinding[] = []
  const visit = (node: Node) => {
    if (isPropertyAssignment(node) && isObjectLiteralExpression(node.parent) && !file.startsWith("packages/env/")
      && (isIdentifier(node.name) || isStringLiteralLike(node.name)) && node.name.text === "admin"
      && unwrap(node.initializer).kind === SyntaxKind.TrueKeyword) {
      findings.push({ file, pattern: "admin: true", rule: "admin-literal" })
    }
    if (isBinaryExpression(node) && comparisonOperators.has(node.operatorToken.kind)
      && !isLiteralOperand(node.left) && !isLiteralOperand(node.right)
      && [...operandNames(node.left), ...operandNames(node.right)].some(name => credentialName.test(name))
      && readsCredentialSource(node)) {
      findings.push({ file, pattern: normalized(node), rule: "secret-compare" })
    }
    if (isFunctionDeclaration(node) && node.name && node.type && isResponseGuardOwner(file)
      && node.modifiers?.some(modifier => modifier.kind === SyntaxKind.ExportKeyword)
      && guardName.test(node.name.text) && responseGuardTypes.has(node.type.getText().replace(/\s+/g, ""))) {
      findings.push({ file, pattern: node.name.text, rule: "response-guard" })
    }
    if (isCallExpression(node) && isPropertyAccessExpression(node.expression) && isIdentifier(node.expression.expression)
      && node.expression.expression.text === "Symbol" && node.expression.name.text === "for") {
      const key = node.arguments[0]
      if (key && isStringLiteralLike(key) && key.text.startsWith("vitehub.") && capabilityKey.test(key.text.split(".").at(-1) ?? "")) {
        findings.push({ file, pattern: normalized(node), rule: "symbol-for-capability" })
      }
    }
    forEachChild(node, visit)
  }
  visit(sourceFile)
  return findings
}

async function packageSourceFindings(): Promise<GrantFinding[]> {
  const findings: GrantFinding[] = []
  const tracked = execFileSync("git", ["ls-files", "-z", "--", "packages"], { cwd: repoRoot, encoding: "utf8" })
  for (const file of tracked.split("\0")) {
    if (!/^packages\/[^/]+\/src\/.+\.[cm]?tsx?$/.test(file) || file.endsWith(".d.ts")) continue
    const path = resolve(repoRoot, file)
    // Keep modified tracked sources in the scan, but use the index blob when a tracked file
    // is absent from the worktree (for example after a local deletion or in a sparse checkout).
    const source = existsSync(path)
      ? readFileSync(path, "utf8")
      : execFileSync("git", ["show", `:${file}`], { cwd: repoRoot, encoding: "utf8" })
    findings.push(...grantFindings(file, source))
  }
  return findings
}

function key(finding: GrantFinding): string {
  return `${finding.rule} ${finding.file}: ${finding.pattern}`
}

describe("grant contract", () => {
  it("finds no new check-here-act-there shapes and no stale exceptions", async () => {
    const found = new Set((await packageSourceFindings()).map(key))
    const allowed = new Set(exceptions.map(key))
    expect([...found].filter(finding => !allowed.has(finding)), "New shapes. Use a grant from @vite-hub/runtime/internal/grant.").toEqual([])
    expect([...allowed].filter(exception => !found.has(exception)), "Stale exceptions. Remove them.").toEqual([])
  }, 30_000)

  it.each([
    ["packages/connections/src/a.ts", "const context = { actor, admin: true }", "admin-literal"],
    ["packages/connections/src/a.ts", "const context = { admin: true as const }", "admin-literal"],
    ["packages/kv/src/a.ts", "if (token !== await readDevToken(root)) deny()", "secret-compare"],
    ["packages/kv/src/a.ts", "if (request.headers.get(\"authorization\") !== `Bearer ${secret}`) deny()", "secret-compare"],
    ["packages/kv/src/a.ts", "if (authorization === signature) allow()", "secret-compare"],
    ["packages/kv/src/a.ts", "if (state != expectedState) deny()", "secret-compare"],
    ["packages/kv/src/a.ts", "if (cookie(request, \"state\") !== oauthState) deny()", "secret-compare"],
    ["packages/auth/src/a.ts", "export async function requireAdmin(request: Request): Promise<Response | undefined> { return }", "response-guard"],
    ["packages/vite-hub/src/console/runtime/server/a.ts", "export function checkAccess(event: Event): Response | undefined { return }", "response-guard"],
    ["packages/workspace/src/a.ts", "const key = Symbol.for(\"vitehub.workspace.writeTarget\")", "symbol-for-capability"],
    ["packages/agent/src/a.ts", "context[Symbol.for(\"vitehub.agent.toolApprove\")]?.()", "symbol-for-capability"],
  ] as const)("detects %s: %s", (file, source, rule) => {
    expect(grantFindings(file, source).map(finding => finding.rule)).toEqual([rule])
  })

  it.each([
    ["packages/env/src/a.ts", "const context = { actor, admin: true }"],
    ["packages/connections/src/a.ts", "const context = { admin: false }"],
    ["packages/kv/src/a.ts", "if (state === \"ready\") run()"],
    ["packages/kv/src/a.ts", "if (typeof token === \"string\") run()"],
    ["packages/kv/src/a.ts", "if (held.token !== lock.token) release()"],
    ["packages/kv/src/a.ts", "if (isSecretEqual(token, await readDevToken(root))) run()"],
    ["packages/kv/src/a.ts", "export async function requireAdmin(request: Request): Promise<Response | undefined> { return }"],
    ["packages/auth/src/a.ts", "async function requireAdmin(request: Request): Promise<Response | undefined> { return }"],
    ["packages/auth/src/a.ts", "export function authPageResponse(response: Response | undefined): Response | undefined { return response }"],
    ["packages/console/src/a.ts", "const slot = Symbol.for(\"vitehub.console.definitions\")"],
  ] as const)("ignores %s: %s", (file, source) => {
    expect(grantFindings(file, source)).toEqual([])
  })
})
