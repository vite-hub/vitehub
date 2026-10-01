import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { builtInChannelEnv } from "./channel-env.ts"
import { discoverAgentDefinitions, tokenizeAgentSource } from "./discovery.ts"

import type { ChannelEnvField } from "./channel-env.ts"

const channelFactoryModules = new Set(["@vite-hub/agent/channels", "vite-hub/agent/channels"])
const agentModules = new Set(["@vite-hub/agent", "vite-hub/agent"])

/** One built-in Channel use in an Agent file. `optionKeys` is undefined when the options are not a static object literal. */
export interface DiscoveredChannelUse {
  kind: string
  optionKeys?: ReadonlySet<string>
}

/** Server Env that the Agents of an application need for their built-in Channels. */
export type AgentChannelEnv = Record<string, Record<string, { names: string[], required: boolean, secret: boolean }>>

function isStringToken(token: string | undefined): boolean {
  return /^["'`]/.test(token ?? "")
}

function stringTokenValue(token: string): string | undefined {
  if (!isStringToken(token) || token.at(-1) !== token[0]) return undefined
  const body = token.slice(1, -1)
  let value = ""
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      value += body[i]
      continue
    }
    const next = body[++i]
    if (next === undefined) return undefined
    if (next === "u") {
      const code = body[i + 1] === "{" ? body.slice(i + 2, body.indexOf("}", i + 2)) : body.slice(i + 1, i + 5)
      if (!/^[0-9a-fA-F]+$/.test(code)) return undefined
      i += body[i + 1] === "{" ? code.length + 2 : 4
      value += String.fromCodePoint(Number.parseInt(code, 16))
    } else if (next === "x") {
      const code = body.slice(i + 1, i + 3)
      if (!/^[0-9a-fA-F]{2}$/.test(code)) return undefined
      i += 2
      value += String.fromCharCode(Number.parseInt(code, 16))
    } else {
      value += ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" }[next] ?? next)
    }
  }
  return value
}

function closingDelimiter(tokens: string[], start: number): number {
  let depth = 0
  for (let i = start; i < tokens.length; i++) {
    if (["{", "(", "["].includes(tokens[i]!)) depth++
    else if (["}", ")", "]"].includes(tokens[i]!) && --depth === 0) return i
  }
  return tokens.length
}

// Visit the top-level properties of the object literal that opens at `start`.
function objectMethodParameters(tokens: string[], key: number): number | undefined {
  const keyEnd = tokens[key] === "[" && isStringToken(tokens[key + 1]) && tokens[key + 2] === "]" ? key + 2 : key
  const next = tokens[keyEnd + 1] === "<" ? skipTypeArguments(tokens, keyEnd + 1) : keyEnd + 1
  return tokens[next] === "(" ? next : undefined
}

// `value` is the index of the first value token, or undefined for a method.
// Returns false when a spread or computed key makes the property list unknown.
function visitObjectProperties(tokens: string[], start: number, visit: (key: string, value: number | undefined, method: boolean) => void): boolean {
  let depth = 0
  let expectKey = true
  let unknown = false
  for (let i = start + 1; i < tokens.length; i++) {
    let token = tokens[i]!
    if (depth === 0) {
      if (token === "}") return !unknown
      if (token === ",") { expectKey = true; continue }
      if (expectKey) {
        const propertyStart = i
        if (token === "[") {
          if (!isStringToken(tokens[i + 1]) || tokens[i + 2] !== "]") return false
          token = tokens[i + 1]!
          i += 2
        }
        if (token === "." && tokens[i + 1] === "." && tokens[i + 2] === ".") {
          unknown = true
          expectKey = false
          continue
        }
        if (["async", "get", "set"].includes(token) && objectMethodParameters(tokens, i + (tokens[i + 1] === "*" ? 2 : 1)) !== undefined) continue
        if (token === "*" && objectMethodParameters(tokens, i + 1) !== undefined) continue
        if (/^[A-Za-z_$][\w$]*$/.test(token) || isStringToken(token)) {
          const key = isStringToken(token) ? stringTokenValue(token) : token
          if (key === undefined) return false
          // A shorthand property `{ telegram }` is its own value.
          const shorthand = !isStringToken(token) && [",", "}"].includes(tokens[i + 1]!)
          const parameters = objectMethodParameters(tokens, i)
          visit(key, tokens[i + 1] === ":" ? i + 2 : shorthand ? i : undefined, parameters !== undefined && !["get", "set"].includes(tokens[propertyStart - 1]!))
          expectKey = false
          if (parameters !== undefined && tokens[i + 1] === "<") i = parameters - 1
        }
      }
    }
    if (["{", "(", "["].includes(token)) depth++
    else if (["}", ")", "]"].includes(token)) depth--
  }
  return false
}

// Keys set to `undefined` or a `void` expression count as omitted, as they do at runtime.
function staticOptionKeys(tokens: string[], start: number, empty: string, typescript: boolean): ReadonlySet<string> | undefined {
  start = skipOptionAssertions(tokens, start, typescript)
  if (isUndefinedValue(tokens, start, new Set([",", ")", "}"]))) return new Set()
  while (tokens[start] === "(") {
    const close = closingDelimiter(tokens, start)
    if (!isValueEnd(tokens, close + 1, new Set([",", ")", "}"]))) return undefined
    const value = skipOptionAssertions(tokens, start + 1, typescript)
    const valueEnd = ["{", "("].includes(tokens[value]!) ? closingDelimiter(tokens, value) : value
    // Only unwrap a single expression, not a comma expression or an operation on a literal.
    if (!isValueEnd(tokens, valueEnd + 1, new Set([")"]))) return undefined
    start = value
  }
  if (tokens[start] === empty) return new Set()
  if (tokens[start] !== "{") return undefined
  const keys = new Set<string>()
  if (!visitObjectProperties(tokens, start, (key, value, method) => {
    const omitted = value === undefined
      ? key === "botToken" && !method
      : isUndefinedValue(tokens, value, new Set([",", "}"])) || (key === "botToken" && canResolveUndefined(tokens, value))
    if (!omitted && (key !== "adapter" || (method || (value !== undefined && isStaticAdapter(tokens, value))))) keys.add(key)
  })) return undefined
  const after = closingDelimiter(tokens, start) + 1
  if (["as", "satisfies"].includes(tokens[after]!) && !isValueEnd(tokens, after, new Set([",", ")", "}"]))) return undefined
  return keys
}

/**
 * Find built-in Channel factory calls, such as `telegram({ ... })` imported from
 * `vite-hub/agent/channels`, and Channel shorthands such as `channels: { telegram: { ... } }`.
 * Source is TypeScript by default. JavaScript files must disable type argument handling.
 */
export function discoverBuiltInChannelUses(source: string, kinds: Iterable<string>, options: { typescript?: boolean } = {}): DiscoveredChannelUse[] {
  const typescript = options.typescript !== false
  const { tokens, lineBreaks } = tokenizeAgentSource(source)
  const known = new Set(kinds)
  const bindings = new Map<string, string>()
  const namespaces = new Set<string>()
  const agentFactories = new Set<string>()
  const agentNamespaces = new Set<string>()
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "import" || tokens[i + 1] === "(" || tokens[i + 1] === "type" || tokens[i - 1] === ".") continue
    let from = i + 1
    while (from < tokens.length && tokens[from] !== "from" && !isStringToken(tokens[from])) from++
    const module = tokens[from] === "from" ? tokens[from + 1]?.slice(1, -1) ?? "" : ""
    const clause = tokens.slice(i + 1, from)
    const channelModule = channelFactoryModules.has(module)
    if (!channelModule && !agentModules.has(module)) continue
    for (let b = 0; b < clause.length; b++) {
      const local = clause[b + 1] === "as" ? clause[b + 2]! : clause[b]!
      if (clause[b] === "*" && clause[b + 1] === "as" && clause[b + 2]) (channelModule ? namespaces : agentNamespaces).add(clause[b + 2]!)
      else if (clause[b - 1] === "as" || clause[b - 1] === "type") continue
      else if (channelModule && known.has(clause[b]!)) bindings.set(local, clause[b]!)
      else if (!channelModule && clause[b] === "defineAgent") agentFactories.add(local)
    }
  }
  const declarations = moduleObjectDeclarations(tokens, lineBreaks, typescript)
  const shadowBindings = new Map([...bindings, ...[...namespaces].map(name => [name, name] as const)])
  const agentBindings = new Map([...agentFactories].map(name => [name, "defineAgent"]))
  const agentShadowBindings = new Map([...agentBindings, ...[...agentNamespaces].map(name => [name, name] as const)])
  const agentNames = new Set(["defineAgent"])
  const uses: Array<DiscoveredChannelUse & { index: number }> = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i - 1] === "." || tokens[i - 1] === "as") continue
    const factory = !isShadowedAt(tokens, i, tokens[i]!, shadowBindings, lineBreaks) && factoryCall(tokens, i, bindings, namespaces, known, lineBreaks, typescript)
    if (factory) uses.push({ index: i, kind: factory.name, optionKeys: staticOptionKeys(tokens, factory.open + 1, ")", typescript) })
    // Shorthands count only in the top-level `channels` option of defineAgent(), not in types or other objects.
    const agent = !isShadowedAt(tokens, i, tokens[i]!, agentShadowBindings, lineBreaks) && factoryCall(tokens, i, agentBindings, agentNamespaces, agentNames, lineBreaks, typescript)
    if (!agent) continue
    const settings = localObject(tokens, agent.open + 1, declarations, typescript)
    if (settings === undefined) continue
    visitObjectProperties(tokens, settings, (option, channelsValue) => {
      const channels = channelsValue === undefined ? undefined : localObject(tokens, channelsValue, declarations, typescript)
      if (option !== "channels" || channels === undefined) return
      visitObjectProperties(tokens, channels, (key, value) => {
        if (value === undefined) return
        const reference = channelFactoryReference(tokens, value, bindings, namespaces, known, typescript)
        if (reference && isShadowedAt(tokens, reference.index, tokens[reference.index]!, shadowBindings, lineBreaks)) return
        // A factory call is found by the call scan. Runtime calls a bare factory without options
        // and uses the kind it returns, whatever the key is.
        if (reference?.call) return
        if (reference) {
          uses.push({ index: value, kind: reference.kind, optionKeys: new Set() })
          return
        }
        if (!known.has(key)) return
        const options = localObject(tokens, value, declarations, typescript) ?? value
        const optionKeys = staticOptionKeys(tokens, options, "}", typescript)
        // An object with `kind` is a complete Channel definition, not built-in Channel options.
        let complete = false
        if (tokens[options] === "{") visitObjectProperties(tokens, options, (key, value) => {
          const omitted = value !== undefined && isUndefinedValue(tokens, value, new Set([",", "}"]))
          if (key === "kind" && !omitted) complete = true
        })
        if (!complete && !optionKeys?.has("kind")) uses.push({ index: value, kind: key, optionKeys })
      })
    })
  }
  return uses.sort((left, right) => left.index - right.index).map(({ kind, optionKeys }) => ({ kind, optionKeys }))
}

function channelFactoryReference(
  tokens: string[],
  index: number,
  bindings: ReadonlyMap<string, string>,
  namespaces: ReadonlySet<string>,
  known: ReadonlySet<string>,
  typescript: boolean,
): { call: boolean, kind: string, index: number, end: number } | undefined {
  index = skipOptionAssertions(tokens, index, typescript)
  if (tokens[index] === "(") {
    const reference = channelFactoryReference(tokens, index + 1, bindings, namespaces, known, typescript)
    const close = closingDelimiter(tokens, index)
    return reference && isValueEnd(tokens, reference.end, new Set([")"])) && isValueEnd(tokens, close + 1, new Set([",", "}", ")"]))
      ? { ...reference, end: close + 1 } : undefined
  }
  let kind = bindings.get(tokens[index]!)
  let next = index + 1
  let member = tokens[next] === "?" && tokens[next + 1] === "." ? next + 1 : next
  if (tokens[member] === "." && tokens[member + 1] === "[") member++
  const memberName = tokens[member] === "[" && tokens[member + 2] === "]" ? stringTokenValue(tokens[member + 1] ?? "") : undefined
  if (!kind && namespaces.has(tokens[index]!)) {
    if (tokens[member] === "." && known.has(tokens[member + 1]!)) {
      kind = tokens[member + 1]!
      next = member + 2
    } else if (memberName !== undefined && known.has(memberName)) {
      kind = memberName
      next = member + 3
    }
  }
  if (tokens[next] === "?" && tokens[next + 1] === ".") next += 2
  if (tokens[next] === "<") {
    if (!typescript) return undefined
    next = skipTypeArguments(tokens, next)
  }
  const call = tokens[next] === "("
  return kind && (call || isValueEnd(tokens, next, new Set([",", "}", ")"]))) ? { call, kind, index, end: call ? closingDelimiter(tokens, next) + 1 : next } : undefined
}

// A method key belongs directly to an object, class, or interface body. Function
// and statement blocks can instead contain a call followed by a standalone block.
function isMethodContainer(tokens: string[], index: number): boolean {
  const stack: number[] = []
  for (let i = 0; i < index; i++) {
    if (["{", "(", "["].includes(tokens[i]!)) stack.push(i)
    else if (["}", ")", "]"].includes(tokens[i]!)) stack.pop()
  }
  const open = stack.at(-1)
  if (open === undefined || tokens[open] !== "{") return false
  return isObjectOrTypeContainer(tokens, open, stack.at(-2))
}

function isObjectOrTypeContainer(tokens: string[], open: number, outer?: number): boolean {
  const previous = tokens[open - 1]
  if (previous === ":") {
    for (let i = open - 2; i >= 0 && !["{", ";"].includes(tokens[i]!); i--) {
      if (["}", ")", "]"].includes(tokens[i]!)) {
        let depth = 1
        while (i > 0 && depth > 0) {
          i--
          if (["}", ")", "]"].includes(tokens[i]!)) depth++
          else if (["{", "(", "["].includes(tokens[i]!)) depth--
        }
        continue
      }
      if (["const", "let", "var", "function", "type"].includes(tokens[i]!)) return true
    }
    // A colon in a statement container introduces a label or case block.
    if (outer === undefined) return false
    if (tokens[outer] !== "{") return true
    const parents: number[] = []
    for (let i = 0; i < outer; i++) {
      if (["{", "(", "["].includes(tokens[i]!)) parents.push(i)
      else if (["}", ")", "]"].includes(tokens[i]!)) parents.pop()
    }
    return isObjectOrTypeContainer(tokens, outer, parents.at(-1))
  }
  // Class and interface bodies remain declarations even after an extends clause.
  let nested = 0
  for (let i = open - 1; i >= 0; i--) {
    const token = tokens[i]!
    if ([")", "]", "}"].includes(token)) { nested++; continue }
    if (["(", "[", "{"].includes(token)) {
      if (nested > 0) { nested--; continue }
      break
    }
    if (nested > 0) continue
    if (["class", "interface"].includes(token) && tokens[i - 1] !== ".") return true
    if (token === "function") return false
    if (token === ";") break
  }
  // Statement blocks have a statement boundary, a control/function header,
  // or an arrow before them. Other braces occur in expressions or types.
  return previous !== undefined && !["{", "}", ";", ")", "else", "do", "try", "catch", "finally", "static"].includes(previous)
    && !(previous === ">" && tokens[open - 2] === "=")
}

function isUndefinedValue(tokens: string[], start: number, terminators: ReadonlySet<string>): boolean {
  if (tokens[start] === "(") {
    const close = closingDelimiter(tokens, start)
    return terminators.has(tokens[close + 1]!) && isUndefinedValue(tokens, start + 1, new Set([")"]))
  }
  if (tokens[start] === "undefined") return isValueEnd(tokens, start + 1, terminators)
  if (tokens[start] !== "void") return false
  return isValueEnd(tokens, unaryOperandEnd(tokens, start + 1), terminators)
}

// A unary operand includes its calls and member accesses, but excludes binary
// operations outside it. `void value + suffix` therefore stays a defined value.
function unaryOperandEnd(tokens: string[], start: number): number {
  while (["void", "typeof", "delete", "await", "new", "+", "-", "!", "~"].includes(tokens[start]!)) start++
  let after = ["(", "[", "{"].includes(tokens[start]!) ? closingDelimiter(tokens, start) + 1 : start + 1
  for (;;) {
    if (tokens[after] === "?" && tokens[after + 1] === ".") after += 2
    else if (tokens[after] === ".") { after += 2; continue }
    else if (tokens[after] === "!" && tokens[after + 1] !== "=") { after++; continue }
    else if (!["(", "["].includes(tokens[after]!)) return after
    if (["(", "["].includes(tokens[after]!)) after = closingDelimiter(tokens, after) + 1
    else after++
  }
}

// Conditional branches and optional access can fall back to Server Env at runtime.
function canResolveUndefined(tokens: string[], start: number, end?: number): boolean {
  const topLevel: number[] = []
  for (let index = start; index < (end ?? tokens.length); index++) {
    if (end === undefined && [",", "}", ")"].includes(tokens[index]!)) { end = index; break }
    topLevel.push(index)
    if (["{", "[", "("].includes(tokens[index]!)) index = closingDelimiter(tokens, index)
  }
  end ??= tokens.length
  const comma = topLevel.findLast(index => tokens[index] === ",")
  if (comma !== undefined) return canResolveUndefined(tokens, comma + 1, end)
  const conditional = topLevel.find(index => tokens[index] === "?" && !["?", "."].includes(tokens[index + 1]!) && tokens[index - 1] !== "?")
  if (conditional !== undefined) {
    let depth = 0
    const colon = topLevel.find(index => {
      if (index <= conditional) return false
      if (tokens[index] === "?" && !["?", "."].includes(tokens[index + 1]!) && tokens[index - 1] !== "?") depth++
      if (tokens[index] !== ":") return false
      return depth-- === 0
    })
    if (colon !== undefined) return canResolveUndefined(tokens, conditional + 1, colon) || canResolveUndefined(tokens, colon + 1, end)
  }
  const fallback = topLevel.findLast(index => ["?", "|"].includes(tokens[index]!) && tokens[index + 1] === tokens[index])
  if (fallback !== undefined) return canResolveUndefined(tokens, fallback + 2, end)
  const conjunction = topLevel.findLast(index => tokens[index] === "&" && tokens[index + 1] === "&")
  if (conjunction !== undefined) return canResolveUndefined(tokens, start, conjunction) || canResolveUndefined(tokens, conjunction + 2, end)
  if (isUndefinedValue(tokens, start, new Set([tokens[end]!]))) return true
  for (const index of topLevel) {
    if (["as", "satisfies"].includes(tokens[index]!)) break
    if (tokens[index] === "?" && tokens[index + 1] === ".") return true
    // Arguments do not describe a call's return value. Grouped expressions do.
    if (tokens[index] === "(" && index === start
      && isValueEnd(tokens, closingDelimiter(tokens, index) + 1, new Set([tokens[end]!]))
      && canResolveUndefined(tokens, index + 1, closingDelimiter(tokens, index))) return true
  }
  return false
}

// Unknown adapter expressions can resolve to undefined and select the built-in
// adapter. Only a complete object or function literal guarantees an override.
function isStaticAdapter(tokens: string[], start: number): boolean {
  if (tokens[start] === "true") return isValueEnd(tokens, start + 1, new Set([",", "}", ")"]))
  if (tokens[start] === "(") {
    const close = closingDelimiter(tokens, start)
    if (isValueEnd(tokens, close + 1, new Set([",", "}", ")"]))) {
      return isStaticAdapter(tokens, start + 1)
    }
  }
  if (tokens[start] === "{") return isValueEnd(tokens, closingDelimiter(tokens, start) + 1, new Set([",", "}", ")"]))
  if (tokens[start] === "async") start++
  if (tokens[start] === "function") {
    const parameters = tokens.indexOf("(", start + 1)
    const body = closingDelimiter(tokens, parameters) + 1
    return tokens[body] === "{" && isValueEnd(tokens, closingDelimiter(tokens, body) + 1, new Set([",", "}", ")"]))
  }
  const afterParameters = tokens[start] === "(" ? closingDelimiter(tokens, start) + 1 : start + 1
  return tokens[afterParameters] === "=" && tokens[afterParameters + 1] === ">"
}

// Non-null and type assertions preserve a value. Reject runtime expressions
// after an assertion before treating it as the end of the original value.
function isValueEnd(tokens: string[], after: number, terminators: ReadonlySet<string>, statementEnd?: (index: number) => boolean): boolean {
  while (tokens[after] === "!" && tokens[after + 1] !== "=") after++
  if (terminators.has(tokens[after]!) || statementEnd?.(after)) return true
  if (!["as", "satisfies"].includes(tokens[after]!)) return false
  let depth = 0
  let conditionalType = false
  let conditionalTypeBranch = false
  for (let i = after + 1; i < tokens.length; i++) {
    const token = tokens[i]!
    if (depth === 0 && token === "," && !terminators.has(token)) return false
    if (depth === 0 && token === "?") {
      if (!conditionalType) return false
      conditionalTypeBranch = true
    }
    if (depth === 0 && token === "extends") conditionalType = true
    if (depth === 0 && token === ":" && conditionalTypeBranch) {
      conditionalType = false
      conditionalTypeBranch = false
    }
    if (depth === 0) {
      if (["+", "*", "/", "%", "^", "~", "in", "instanceof"].includes(token)
        || (["|", "&", "?"].includes(token) && tokens[i + 1] === token)) return false
      // Negative literal types can start a type operand; subtraction cannot.
      if (token === "-" && (!/^(?:\d|\.\d)/.test(tokens[i + 1] ?? "")
        || (!["as", "satisfies", "|", "&", "?", ":", "extends"].includes(tokens[i - 1]!)
          && !(tokens[i - 1] === ">" && tokens[i - 2] === "=")))) return false
      if (token === "=" && tokens[i + 1] !== ">") return false
      if (token === ">" && tokens[i - 1] !== "=") return false
      if (token === "!" && tokens[i + 1] === "=") return false
    }
    if (token === "<") {
      if (["<", "="].includes(tokens[i + 1]!)) return false
      const end = skipTypeArguments(tokens, i)
      if (tokens[end - 1] !== ">") return false
      i = end - 1
      continue
    }
    if (["(", "[", "{"].includes(token)) depth++
    else if ([")", "]", "}"].includes(token)) {
      if (depth === 0) return terminators.has(token)
      depth--
    }
    else if (depth === 0 && (terminators.has(token) || (i > after + 1 && statementEnd?.(i)))) return true
  }
  return statementEnd?.(tokens.length) ?? false
}

// Resolve an object literal, or a module-level `const name = { ... }` reference to one.
function localObject(tokens: string[], index: number, declarations: ReadonlyMap<string, number>, typescript: boolean): number | undefined {
  for (;;) {
    index = skipOptionAssertions(tokens, index, typescript)
    if (tokens[index] !== "(") break
    const value = skipOptionAssertions(tokens, index + 1, typescript)
    const valueEnd = ["{", "("].includes(tokens[value]!) ? closingDelimiter(tokens, value) : value
    if (!isValueEnd(tokens, valueEnd + 1, new Set([")"]))) return undefined
    index = value
  }
  if (tokens[index] === "{") return index
  const declaration = declarations.get(tokens[index]!)
  return declaration !== undefined && tokens[declaration] === "{" && isValueEnd(tokens, index + 1, new Set([",", "}", ")"])) ? declaration : undefined
}

function isShadowedAt(tokens: string[], index: number, name: string, bindings: ReadonlyMap<string, string>, lineBreaks: ReadonlySet<number>): boolean {
  if (!bindings.has(name)) return false
  if (hasLocalBinding(tokens, index, name, lineBreaks)) return true
  const closes = new Map<number, number>()
  const stack: number[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (["{", "(", "["].includes(tokens[i]!)) stack.push(i)
    else if (["}", ")", "]"].includes(tokens[i]!)) {
      const open = stack.pop()
      if (open !== undefined) closes.set(open, i)
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "function") continue
    const open = tokens.indexOf("(", i + 1)
    if (open < 0) continue
    let depth = 0
    let close = open
    for (; close < tokens.length; close++) {
      if (["(", "[", "{"].includes(tokens[close]!)) depth++
      else if ([")", "]", "}"].includes(tokens[close]!) && --depth === 0) break
    }
    if (tokens[close + 1] !== "{") continue
    if (!parameterListHasName(tokens, open + 1, close, name, closes)) continue
    let bodyDepth = 0
    let end = close + 1
    for (; end < tokens.length; end++) {
      if (["{", "(", "["].includes(tokens[end]!)) bodyDepth++
      else if (["}", ")", "]"].includes(tokens[end]!) && --bodyDepth === 0) break
    }
    if (index > close && index < end) return true
  }
  // Object and class methods, including constructors, have parameter scopes
  // without the `function` keyword.
  for (let open = 0; open < tokens.length; open++) {
    if (tokens[open] !== "(") continue
    const previous = tokens[open - 1]
    if (["if", "while", "for", "switch", "catch", "with", "function"].includes(previous!)) continue
    const close = closes.get(open)
    let body = close === undefined ? undefined : close + 1
    if (body !== undefined && tokens[body] === ":") {
      body++
      let expectType = true
      while (body < tokens.length) {
        const token = tokens[body]!
        if (token === "{" && !expectType) break
        if (token === "=" && tokens[body + 1] === ">") {
          expectType = true
          body += 2
          continue
        }
        if (token === ";" || token === "=") break
        if (token === "<") { body = skipTypeArguments(tokens, body); continue }
        expectType = ["|", "&", "?", ":"].includes(token)
        body = (closes.get(body) ?? body) + 1
      }
    }
    if (close === undefined || tokens[body!] !== "{") continue
    if (!parameterListHasName(tokens, open + 1, close, name, closes)) continue
    const end = closes.get(body!) ?? body!
    if (index > close && index < end) return true
  }
  // A single arrow parameter may omit parentheses: `telegram => telegram()`.
  for (let parameter = 0; parameter < tokens.length; parameter++) {
    if (tokens[parameter] !== name || tokens[parameter + 1] !== "=" || tokens[parameter + 2] !== ">") continue
    const body = parameter + 3
    if (tokens[body] === "{") {
      const end = closes.get(body) ?? body
      if (index > parameter + 2 && index < end) return true
    } else {
      const end = expressionBodyEnd(tokens, body, lineBreaks)
      if (index >= body && index < end) return true
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "(") continue
    let depth = 1
    let close = i + 1
    for (; close < tokens.length && depth; close++) {
      if (tokens[close] === "(") depth++
      else if (tokens[close] === ")") depth--
    }
    if (tokens[close] !== "=" || tokens[close + 1] !== ">") continue
    if (!parameterListHasName(tokens, i + 1, close, name, closes)) continue
    const body = close + 2
    if (tokens[body] !== "{") {
      const end = expressionBodyEnd(tokens, body, lineBreaks)
      if (index >= body && index < end) return true
      continue
    }
    let bodyDepth = 1
    let end = body + 1
    for (; end < tokens.length && bodyDepth; end++) {
      if (tokens[end] === "{") bodyDepth++
      else if (tokens[end] === "}") bodyDepth--
    }
    if (index > body && index < end) return true
  }
  return false
}

function parameterListHasName(tokens: string[], start: number, end: number, name: string, closes: ReadonlyMap<number, number>): boolean {
  for (let entry = start; entry < end;) {
    if (tokens[entry] === ",") { entry++; continue }
    let binding = entry
    if (tokens[binding] === ".") binding += 3
    while (["private", "protected", "public", "readonly", "override"].includes(tokens[binding]!)) binding++
    if (bindingPatternHasName(tokens, binding, name, closes)) return true
    const nestedEnd = closes.get(binding)
    entry = nestedEnd !== undefined ? nestedEnd + 1 : binding + 1
    while (entry < end && tokens[entry] !== ",") entry = (closes.get(entry) ?? entry) + 1
  }
  return false
}

function expressionBodyEnd(tokens: string[], start: number, lineBreaks: ReadonlySet<number>, stopAtComma = true): number {
  const stack: string[] = []
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i]!
    const previous = tokens[i - 1]
    if (stack.length === 0 && i > start && lineBreaks.has(i)
      && /^[A-Za-z_$][\w$]*$/.test(token) && !["in", "instanceof", "as", "satisfies"].includes(token)
      && ([")", "]", "}"].includes(previous!) || (/^[A-Za-z_$][\w$]*$/.test(previous ?? "")
        && !["await", "new", "typeof", "void", "delete", "yield", "in", "instanceof", "as", "satisfies"].includes(previous!)))) return i
    if (token === "(" || token === "[" || token === "{") {
      stack.push(token)
      continue
    }
    if (token === ")" || token === "]" || token === "}") {
      if (stack.length === 0) return i
      stack.pop()
      continue
    }
    if (stack.length === 0 && (token === ";" || (stopAtComma && token === ","))) return i
  }
  return tokens.length
}

// An unbraced loop owns one complete statement, including nested control flow.
function statementEnd(tokens: string[], start: number, closes: ReadonlyMap<number, number>, lineBreaks: ReadonlySet<number>): number {
  if (tokens[start] === "{") return (closes.get(start) ?? start) + 1
  if (tokens[start] === ";") return start + 1
  if (["if", "for", "while", "with", "switch"].includes(tokens[start]!)) {
    const params = tokens[start + 1] === "await" ? start + 2 : start + 1
    const close = closes.get(params)
    if (close !== undefined) {
      const end = statementEnd(tokens, close + 1, closes, lineBreaks)
      return tokens[start] === "if" && tokens[end] === "else" ? statementEnd(tokens, end + 1, closes, lineBreaks) : end
    }
  }
  if (tokens[start] === "do") {
    const end = statementEnd(tokens, start + 1, closes, lineBreaks)
    const close = tokens[end] === "while" ? closes.get(end + 1) : undefined
    if (close !== undefined) return tokens[close + 1] === ";" ? close + 2 : close + 1
    return end
  }
  if (tokens[start] === "try") {
    let end = statementEnd(tokens, start + 1, closes, lineBreaks)
    if (tokens[end] === "catch") {
      const close = tokens[end + 1] === "(" ? closes.get(end + 1) : end
      if (close !== undefined) end = statementEnd(tokens, close + 1, closes, lineBreaks)
    }
    if (tokens[end] === "finally") end = statementEnd(tokens, end + 1, closes, lineBreaks)
    return end
  }
  if (/^[A-Za-z_$][\w$]*$/.test(tokens[start] ?? "") && tokens[start + 1] === ":") return statementEnd(tokens, start + 2, closes, lineBreaks)
  const end = expressionBodyEnd(tokens, start, lineBreaks, false)
  return tokens[end] === ";" ? end + 1 : end
}

// Lexical declarations shadow the import throughout their block. `var` belongs
// to the enclosing function, including declarations inside a nested block.
function hasLocalBinding(tokens: string[], index: number, name: string, lineBreaks: ReadonlySet<number>): boolean {
  const closes = new Map<number, number>()
  const stack: number[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (["{", "(", "["].includes(tokens[i]!)) stack.push(i)
    else if (["}", ")", "]"].includes(tokens[i]!)) {
      const open = stack.pop()
      if (open !== undefined) closes.set(open, i)
    }
  }
  const functionBodies = new Set<number>()
  const loopScopes = new Map<number, number>()
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "function") {
      const params = tokens.indexOf("(", i + 1)
      const body = (closes.get(params) ?? tokens.length) + 1
      if (tokens[body] === "{") functionBodies.add(body)
    }
    if (tokens[i] === "=" && tokens[i + 1] === ">" && tokens[i + 2] === "{") functionBodies.add(i + 2)
    if (tokens[i] === "for") {
      const params = tokens[i + 1] === "await" ? i + 2 : i + 1
      const close = closes.get(params)
      if (close !== undefined) {
        const body = close + 1
        const end = statementEnd(tokens, body, closes, lineBreaks)
        loopScopes.set(params, end)
      }
    }
    // Method bodies have parameters too, but control-flow blocks are lexical scopes.
    if (tokens[i] === "(" && !["if", "while", "for", "switch", "catch", "with"].includes(tokens[i - 1]!)) {
      const body = (closes.get(i) ?? tokens.length) + 1
      if (tokens[body] === "{") functionBodies.add(body)
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    const declaration = tokens[i]!
    if (declaration === "catch" && tokens[i + 1] === "(") {
      const body = (closes.get(i + 1) ?? tokens.length) + 1
      if (tokens[body] === "{" && index > body && index < (closes.get(body) ?? body)
        && bindingPatternHasName(tokens, i + 2, name, closes)) return true
    }
    if (!["const", "let", "var", "function", "class"].includes(declaration)) continue
    let scope = -1
    for (const [open, close] of closes) {
      if (tokens[open] !== "{" || open >= i || close <= i) continue
      if (declaration === "var" && !functionBodies.has(open)) continue
      if (open > scope) scope = open
    }
    if (declaration !== "var") for (const open of loopScopes.keys()) {
      if (open < i && (closes.get(open) ?? -1) > i && open > scope) scope = open
    }
    const endOfScope = loopScopes.get(scope) ?? closes.get(scope) ?? tokens.length
    if (index <= scope || index >= endOfScope) continue
    if (declaration === "function" || declaration === "class") {
      const binding = tokens[i + 1] === "*" ? i + 2 : i + 1
      if (tokens[binding] !== name) continue
      // Named expressions bind only inside their own body, unlike declarations.
      if (["=", "(", ":", ",", "return"].includes(tokens[i - 1]!)) {
        const params = declaration === "function" ? tokens.indexOf("(", binding + 1) : -1
        const body = declaration === "function" ? (closes.get(params) ?? tokens.length) + 1 : tokens.indexOf("{", binding + 1)
        if (index !== binding && !(index > body && index < (closes.get(body) ?? body))) continue
      }
      return true
    }
    // Walk declarators without mistaking identifiers in initializers for bindings.
    for (let binding = i + 1; binding < tokens.length;) {
      const end = closes.get(binding)
      if (bindingPatternHasName(tokens, binding, name, closes)) return true
      let next = (end ?? binding) + 1
      while (next < tokens.length && !["=", ",", ";", "in", "of", ")", "}"].includes(tokens[next]!)) next++
      if (tokens[next] === "=") {
        next++
        while (next < tokens.length && ![",", ";", ")", "}"].includes(tokens[next]!)) {
          next = (closes.get(next) ?? next) + 1
          if (["const", "let", "var", "return", "export"].includes(tokens[next]!)) break
        }
      }
      if (tokens[next] !== ",") break
      binding = next + 1
    }
  }
  return false
}

// Computed property keys and default values are expressions, not new bindings.
function bindingPatternHasName(tokens: string[], start: number, name: string, closes: ReadonlyMap<number, number>): boolean {
  if (!["{", "["].includes(tokens[start]!)) return tokens[start] === name
  const end = closes.get(start) ?? start
  for (let entry = start + 1; entry < end;) {
    if (tokens[entry] === ",") { entry++; continue }
    let binding = entry
    if (tokens[entry] === ".") binding += 3
    else if (tokens[start] === "{") {
      const next = (closes.get(entry) ?? entry) + 1
      if (tokens[next] === ":") binding = next + 1
    }
    if (bindingPatternHasName(tokens, binding, name, closes)) return true
    let next = (closes.get(binding) ?? binding) + 1
    while (next < end && tokens[next] !== ",") next = (closes.get(next) ?? next) + 1
    entry = next + 1
  }
  return false
}

// Map module-level const object initializers to the index of their opening brace.
function moduleObjectDeclarations(tokens: string[], lineBreaks: ReadonlySet<number>, typescript: boolean): Map<string, number> {
  const declarations = new Map<string, number>()
  // A newline before an identifier ends the initializer unless it continues
  // an assertion or a binary expression. Operators can continue across lines.
  const statementEnd = (index: number) => index === tokens.length || (lineBreaks.has(index)
    && /^[A-Za-z_$][\w$]*$/.test(tokens[index]!) && !["as", "satisfies", "in", "instanceof"].includes(tokens[index]!))
  let depth = 0
  let constantDeclaration = false
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (depth === 0 && (token === ";" || (token !== "const" && statementEnd(i)))) constantDeclaration = false
    if (depth === 0 && token === "const") constantDeclaration = true
    if (depth === 0 && constantDeclaration && ["const", ","].includes(token) && /^[A-Za-z_$][\w$]*$/.test(tokens[i + 1] ?? "")) {
      let equals = i + 2
      while (tokens[equals] && !["=", ",", ";", "const", "let", "var", "declare", "export", "import"].includes(tokens[equals]!)) {
        if (["{", "(", "["].includes(tokens[equals]!)) equals = closingDelimiter(tokens, equals) + 1
        else if (typescript && tokens[equals] === "<") equals = skipTypeArguments(tokens, equals)
        else equals++
      }
      if (tokens[equals] === "=") {
        const start = skipOptionAssertions(tokens, equals + 1, typescript)
        const object = localObject(tokens, start, declarations, typescript)
        const end = ["{", "("].includes(tokens[start]!) ? closingDelimiter(tokens, start) + 1 : start + 1
        if (object !== undefined && isValueEnd(tokens, end, new Set([",", ";"]), statementEnd)) declarations.set(tokens[i + 1]!, object)
      }
    }
    if (["{", "(", "["].includes(token)) depth++
    else if (["}", ")", "]"].includes(token)) depth--
  }
  return declarations
}

// Match `name(`, `name<T>(`, `namespace.name(`, or `namespace.name<T>(` and return the opening parenthesis.
function factoryCall(
  tokens: string[],
  index: number,
  bindings: ReadonlyMap<string, string>,
  namespaces: ReadonlySet<string>,
  names: ReadonlySet<string>,
  lineBreaks: ReadonlySet<number>,
  typescript: boolean,
): { name: string, open: number } | undefined {
  if (tokens[index - 1] === "#") return undefined
  let name = bindings.get(tokens[index]!)
  let next = index + 1
  let member = tokens[next] === "?" && tokens[next + 1] === "." ? next + 1 : next
  if (tokens[member] === "." && tokens[member + 1] === "[") member++
  const memberName = tokens[member] === "[" && tokens[member + 2] === "]" ? stringTokenValue(tokens[member + 1] ?? "") : undefined
  if (!name && namespaces.has(tokens[index]!)) {
    if (tokens[member] === "." && names.has(tokens[member + 1]!)) {
      name = tokens[member + 1]!
      next = member + 2
    } else if (memberName !== undefined && names.has(memberName)) {
      name = memberName
      next = member + 3
    }
  }
  if (!name) return undefined
  if (tokens[next] === "?" && tokens[next + 1] === ".") next += 2
  if (tokens[next] === "<") {
    if (!typescript) return undefined
    next = skipTypeArguments(tokens, next)
  }
  if (tokens[next] !== "(") return undefined
  const after = tokens[closingDelimiter(tokens, next) + 1]
  const previous = tokens[index - 1]!
  const afterType = lineBreaks.has(index) && (/^[A-Za-z_$][\w$]*$/.test(previous) || [">", "]"].includes(previous))
    && (!["await", "yield", "return", "throw", "new", "typeof", "void", "delete", "in", "instanceof"].includes(previous) || (previous === "void" && tokens[index - 2] === ":"))
  // Method keys are declarations. A call can precede a ternary colon, so also
  // require the key to follow a property boundary or a method modifier.
  if (["{", ":"].includes(after!) && (afterType || followsDecorator(tokens, index) || ["{", "}", ",", ";", "async", "get", "set", "*", "static", "public", "private", "protected", "abstract", "declare", "override"].includes(previous)) && isMethodContainer(tokens, index)) return undefined
  return { name, open: next }
}

// Decorator calls can separate a method key from its property boundary.
function followsDecorator(tokens: string[], index: number): boolean {
  let previous = index - 1
  if (tokens[previous] === ")") {
    let depth = 1
    while (previous > 0 && depth > 0) {
      previous--
      if (tokens[previous] === ")") depth++
      else if (tokens[previous] === "(") depth--
    }
    previous--
  }
  if (tokens[previous] === ">") {
    let depth = 1
    while (previous > 0 && depth > 0) {
      previous--
      if (tokens[previous] === ">" && tokens[previous - 1] !== "=") depth++
      else if (tokens[previous] === "<") depth--
    }
    previous--
  }
  while (previous >= 0 && (/^[A-Za-z_$][\w$]*$/.test(tokens[previous]!) || tokens[previous] === ".")) previous--
  return tokens[previous] === "@"
}

// Angle-bracket assertions are TypeScript syntax, not JavaScript comparisons.
function skipOptionAssertions(tokens: string[], start: number, typescript: boolean): number {
  while (typescript && tokens[start] === "<") start = skipTypeArguments(tokens, start)
  return start
}

function skipTypeArguments(tokens: string[], start: number): number {
  let depth = 0
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i] === "<") depth++
    // The tokenizer splits `=>` into `=` and `>`; an arrow does not close a type argument list.
    else if (tokens[i] === ">" && tokens[i - 1] !== "=" && --depth === 0) return i + 1
  }
  return tokens.length
}

/**
 * Declare the Server Env of each built-in Channel used by a discovered Agent.
 * A value is required when an Agent uses the Channel with static options that omit it.
 */
export function discoverAgentChannelEnv(options: { rootDir: string, serverDirs?: string[] }): AgentChannelEnv {
  const handlers = new Set([
    ...discoverAgentDefinitions({ mode: "vite-suffix", rootDir: options.rootDir }),
    ...discoverAgentDefinitions({ mode: "server-agents", scanDirs: options.serverDirs ?? [resolve(options.rootDir, "server")] }),
  ].map(definition => definition.handler))
  const fields: Readonly<Record<string, Readonly<Record<string, ChannelEnvField>>>> = builtInChannelEnv
  const declared: AgentChannelEnv = {}
  for (const handler of handlers) {
    for (const { kind, optionKeys } of discoverBuiltInChannelUses(readFileSync(handler, "utf8"), Object.keys(fields), { typescript: /\.(?:c|m)?ts$/i.test(handler) })) {
      const group = declared[kind] ??= {}
      for (const [field, spec] of Object.entries(fields[kind] ?? {})) {
        const entry = group[field] ??= { names: [...spec.names], required: false, secret: spec.secret === true }
        if (optionKeys && spec.requiredUnless && !spec.requiredUnless.some(key => optionKeys.has(key))) entry.required = true
      }
    }
  }
  return declared
}
