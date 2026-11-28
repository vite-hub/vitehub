import { relative } from "node:path"
import ts from "typescript"
import { createChecker } from "vue-component-meta"
import type { PropertyMeta } from "vue-component-meta"

export const entrySources: Readonly<Record<string, string>> = {
  ".": "src/index.ts",
  "./headless": "src/headless.ts",
  "./markdown-editor": "src/markdown-editor.ts",
  "./motion": "src/motion.ts",
  "./motion/core": "src/motion-core.ts",
  "./nuxt": "src/nuxt.ts",
  "./playground": "src/playground.ts",
  "./theme": "src/theme.ts",
  "./vite": "src/vite.ts",
  "./workspace": "src/workspace.ts",
}

export interface ApiProp {
  name: string
  type: string
  values?: string[]
  default?: string
  required: boolean
}

export interface ApiEvent {
  name: string
  type: string
}

export interface ApiComponent {
  name: string
  entries: string[]
  source: string
  props: ApiProp[]
  events: ApiEvent[]
  slots: string[]
  dataSlots: string[]
  rootDataSlots: string[]
  dataAttributes: string[]
  types: string[]
}

export interface ApiReport {
  package: "@vite-hub/ui"
  components: ApiComponent[]
}

const typeFormat = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope
const byName = <T extends { name: string }>(a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
const sorted = (values: Iterable<string>) => [...new Set(values)].sort()
const camelize = (value: string) => value.replace(/-(\w)/g, (_, char: string) => char.toUpperCase())
const listenerName = (event: string) => `on${camelize(event).replace(/^./, (char) => char.toUpperCase())}`

export const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z])([A-Z][a-z])/g, "$1-$2").toLowerCase()

export function buildReport(packageRoot: string): ApiReport {
  const checker = createChecker(`${packageRoot}/tsconfig.build.json`, { schema: false })
  const program = checker.getProgram()
  if (!program) throw new TypeError("vue-component-meta did not create a TypeScript program for tsconfig.build.json.")
  const typeChecker = program.getTypeChecker()
  const repoRoot = `${packageRoot.replace(/\/packages\/ui\/?$/, "")}/`

  interface Found { name: string; declaration: ts.VariableDeclaration; entries: Set<string> }
  const found = new Map<string, Found>()
  const exportedNames = new Set<string>()

  for (const [entry, source] of Object.entries(entrySources)) {
    const file = program.getSourceFile(`${packageRoot}/${source}`)
    const moduleSymbol = file && typeChecker.getSymbolAtLocation(file)
    if (!moduleSymbol) throw new TypeError(`${source} is not in the program of tsconfig.build.json.`)
    for (const exported of typeChecker.getExportsOfModule(moduleSymbol)) {
      exportedNames.add(exported.getName())
      const symbol = exported.flags & ts.SymbolFlags.Alias ? typeChecker.getAliasedSymbol(exported) : exported
      const declaration = symbol.valueDeclaration
      if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) continue
      const type = typeChecker.getTypeOfSymbolAtLocation(symbol, declaration)
      if (!type.getConstructSignatures().some((signature) => signature.getReturnType().getProperty("$props"))) continue
      const key = `${declaration.getSourceFile().fileName}#${declaration.name.text}#${exported.getName()}`
      const item = found.get(key) ?? { name: exported.getName(), declaration, entries: new Set<string>() }
      item.entries.add(entry)
      found.set(key, item)
    }
  }

  const components = [...found.values()].map(({ name, declaration, entries }): ApiComponent => {
    const file = declaration.getSourceFile()
    const localName = (declaration.name as ts.Identifier).text
    const meta = checker.getComponentMeta(file.fileName, localName)
    const scan = scanSource(file, declaration)
    const props: ApiProp[] = []
    const print = (type: ts.Type | undefined, fallback: string) => clean(type ? typeChecker.typeToString(type, declaration, typeFormat) : fallback, repoRoot)
    const events = new Map<string, ApiEvent>(meta.events.map((event) => [event.name, { name: event.name, type: print(event.getTypeObject(), event.type) }]))
    for (const prop of meta.props) {
      if (prop.global) continue
      const emitted = scan.emits.find((event) => listenerName(event) === prop.name)
      if (emitted !== undefined) {
        if (!events.has(emitted)) events.set(emitted, { name: emitted, type: "unknown[]" })
        continue
      }
      props.push(apiProp(prop, print(prop.getTypeObject(), prop.type)))
    }
    return {
      name,
      entries: sorted(entries),
      source: relative(packageRoot, file.fileName),
      props: props.sort(byName),
      events: [...events.values()].sort(byName),
      slots: sorted([...meta.slots.map((slot) => slot.name), ...forwardedSlots(declaration, typeChecker, scan)]),
      dataSlots: sorted(scan.dataSlots),
      rootDataSlots: sorted(scan.rootDataSlots),
      dataAttributes: sorted(scan.dataAttributes),
      types: ["Props", "Emits", "Slots"].map((suffix) => `${name}${suffix}`).filter((typeName) => exportedNames.has(typeName)),
    }
  })

  return { package: "@vite-hub/ui", components: components.sort((a, b) => byName(a, b) || (a.source < b.source ? -1 : 1)) }
}

export function serializeReport(report: ApiReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

function apiProp(prop: PropertyMeta, type: string): ApiProp {
  const result: ApiProp = { name: prop.name, type, required: prop.required }
  const values = stringLiterals(prop.getTypeObject())
  if (values) result.values = values
  if (prop.default !== undefined && prop.default !== "undefined") result.default = prop.default
  return result
}

function stringLiterals(type: ts.Type): string[] | undefined {
  const members = type.isUnion() ? type.types : [type]
  const values: string[] = []
  for (const member of members) {
    if (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) continue
    if (!member.isStringLiteral()) return undefined
    values.push(member.value)
  }
  return values.length ? values.sort() : undefined
}

function clean(type: string, repoRoot: string): string {
  return type.split(repoRoot).join("").replace(/import\("[^"]*node_modules\/\.pnpm\/[^"]*?node_modules\/([^"]+)"\)/g, "import(\"$1\")")
}

interface SourceScan {
  dataSlots: Set<string>
  rootDataSlots: Set<string>
  dataAttributes: Set<string>
  slots: Set<string>
  slotAccesses: ts.ElementAccessExpression[]
  renders: ts.CallExpression[]
  emits: string[]
}

export function scanSource(file: ts.SourceFile, declaration: ts.VariableDeclaration): SourceScan {
  const topLevel = new Map<string, ts.Node>()
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) topLevel.set(statement.name.text, statement)
    if (ts.isVariableStatement(statement)) {
      for (const item of statement.declarationList.declarations) if (ts.isIdentifier(item.name)) topLevel.set(item.name.text, item)
    }
  }
  const slotHelpers = new Map([["kitSlot", 1], ["slotPart", 1]])
  for (const [name, node] of topLevel) {
    const index = slotParameter(node)
    if (index !== undefined) slotHelpers.set(name, index)
  }
  const scan: SourceScan = { dataSlots: new Set(), rootDataSlots: new Set(), dataAttributes: new Set(), slots: new Set(), slotAccesses: [], renders: [], emits: [] }
  const visited = new Set<ts.Node>()
  const others = new Set([...topLevel.values()].filter((node) => isComponentDeclaration(node) && node !== declaration))

  const literals = (node: ts.Expression): string[] => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text]
    if (ts.isTemplateExpression(node)) return [`${node.head.text}*`]
    if (ts.isConditionalExpression(node)) return [...literals(node.whenTrue), ...literals(node.whenFalse)]
    if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return literals(node.right)
    if (ts.isParenthesizedExpression(node)) return literals(node.expression)
    return []
  }

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const key = ts.isStringLiteral(node.name) || ts.isIdentifier(node.name) ? node.name.text : undefined
      if (key === "data-slot") for (const value of literals(node.initializer)) scan.dataSlots.add(value)
      else if (key?.startsWith("data-")) scan.dataAttributes.add(key)
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const index = slotHelpers.get(node.expression.text)
      const slot = index === undefined ? undefined : node.arguments[index]
      if (slot) for (const value of literals(slot)) scan.dataSlots.add(value)
    }
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isSlots(node.expression)) {
      const keys = ts.isPropertyAccessExpression(node) ? [node.name.text] : literals(node.argumentExpression)
      for (const key of keys) scan.slots.add(key)
      if (ts.isElementAccessExpression(node)) scan.slotAccesses.push(node)
    }
    if (isCall(node, "h") && node.arguments.length >= 3) scan.renders.push(node)
    if (isCall(node, "renderSlot") && isSlots(node.arguments[0]) && node.arguments[1]) {
      for (const key of literals(node.arguments[1])) scan.slots.add(key)
    }
    if (ts.isIdentifier(node)) {
      const target = topLevel.get(node.text)
      if (target && !others.has(target) && !visited.has(target)) {
        visited.add(target)
        visit(target)
      }
    }
    ts.forEachChild(node, visit)
  }

  visited.add(declaration)
  visit(declaration)
  const localValues = new Map<string, ts.Expression>()
  const getRootSlots = (expression: ts.Expression): string[] => {
    if (ts.isParenthesizedExpression(expression)) return getRootSlots(expression.expression)
    if (ts.isConditionalExpression(expression)) return [...getRootSlots(expression.whenTrue), ...getRootSlots(expression.whenFalse)]
    if (!isCall(expression, "h") && !isCall(expression, "slotPart")) return []
    const attrs = expression.arguments[1]
    if (isCall(expression, "slotPart")) return attrs ? literals(attrs) : []
    const fromAttrs = (node: ts.Expression, seen = new Set<ts.Expression>()): string[] => {
      if (seen.has(node)) return []
      const next = new Set(seen).add(node)
      if (ts.isIdentifier(node)) {
        const value = localValues.get(node.text)
        return value ? fromAttrs(value, next) : []
      }
      if (isCall(node, "mergeProps")) return node.arguments.flatMap((arg) => fromAttrs(arg, next))
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const index = slotHelpers.get(node.expression.text)
        const slot = index === undefined ? undefined : node.arguments[index]
        return slot ? literals(slot) : []
      }
      if (!ts.isObjectLiteralExpression(node)) return []
      return node.properties.flatMap((prop) => {
        if (ts.isSpreadAssignment(prop)) return fromAttrs(prop.expression, next)
        return ts.isPropertyAssignment(prop) && ts.isStringLiteral(prop.name) && prop.name.text === "data-slot" ? literals(prop.initializer) : []
      })
    }
    const children = expression.arguments[2]
    const render = children && ts.isObjectLiteralExpression(children) && children.properties.find((prop) => ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "render")
    const override = render && ts.isPropertyAssignment(render) && isCall(render.initializer, "kitSlot") ? render.initializer.arguments[1] : undefined
    return [...attrs ? fromAttrs(attrs) : [], ...override ? literals(override) : []]
  }
  const call = declaration.initializer
  if (isCall(call, "slotPart")) {
    for (const key of getRootSlots(call)) scan.rootDataSlots.add(key)
  }
  const options = isCall(call, "defineComponent") ? call.arguments[0] : undefined
  const setup = options && ts.isObjectLiteralExpression(options) && options.properties.find((prop) => ts.isMethodDeclaration(prop) && ts.isIdentifier(prop.name) && prop.name.text === "setup")
  if (setup && ts.isMethodDeclaration(setup) && setup.body) {
    for (const render of returns(setup.body)) {
      if (!ts.isArrowFunction(render) && !ts.isFunctionExpression(render)) continue
      if (ts.isBlock(render.body)) {
        for (const statement of render.body.statements) {
          if (!ts.isVariableStatement(statement)) continue
          for (const item of statement.declarationList.declarations) {
            if (ts.isIdentifier(item.name) && item.initializer) localValues.set(item.name.text, item.initializer)
          }
        }
      }
      for (const root of ts.isBlock(render.body) ? returns(render.body) : [render.body]) {
        for (const key of getRootSlots(root)) scan.rootDataSlots.add(key)
      }
    }
  }
  scan.emits = emitNames(declaration)
  return scan
}

function isCall<Name extends string>(node: ts.Node | undefined, name: Name): node is ts.CallExpression & { expression: ts.Identifier & { text: Name } } {
  return !!node && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name
}

function forwardedSlots(declaration: ts.VariableDeclaration, checker: ts.TypeChecker, sourceScan: SourceScan): Set<string> {
  const seen = new Set<ts.VariableDeclaration>()
  const referencedDeclaration = (node: ts.Node) => {
    const symbol = checker.getSymbolAtLocation(node)
    return (symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol)?.valueDeclaration
  }
  const forwards = (node: ts.Node, seenNodes = new Set<ts.Node>()): boolean => {
    if (seenNodes.has(node)) return false
    seenNodes.add(node)
    if (isSlots(node)) return true
    if (ts.isObjectLiteralExpression(node)) return node.properties.some((prop) => ts.isSpreadAssignment(prop) && forwards(prop.expression, seenNodes))
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression) && ts.isCallExpression(node.expression.expression) && forwards(node.expression.expression, seenNodes)) return true
      if (node.arguments.some((arg) => forwards(arg, seenNodes))) return true
      return ts.isIdentifier(node.expression) && forwards(node.expression, seenNodes)
    }
    if (ts.isIdentifier(node)) {
      const target = referencedDeclaration(node)
      return !!target && ts.isVariableDeclaration(target) && !!target.initializer && forwards(target.initializer, seenNodes)
    }
    return ts.isArrowFunction(node) && forwards(node.body, seenNodes)
  }
  const slotKeys = (node: ts.Node) => {
    const result = new Set<string>()
    for (const signature of checker.getTypeAtLocation(node).getConstructSignatures()) {
      const slots = signature.getReturnType().getProperty("$slots")
      if (!slots) continue
      const type = checker.getTypeOfSymbol(slots)
      for (const prop of type.getProperties()) result.add(prop.name)
      for (const index of checker.getIndexInfosOfType(type)) {
        if (index.keyType.flags & ts.TypeFlags.String) result.add("*")
        if (index.keyType.flags & ts.TypeFlags.TemplateLiteral) result.add((index.keyType as ts.TemplateLiteralType).texts.join("*"))
      }
    }
    return result
  }
  const collect = (item: ts.VariableDeclaration, scan: SourceScan): Set<string> => {
    if (seen.has(item)) return new Set()
    seen.add(item)
    const result = new Set(scan.slots)
    for (const read of scan.slotAccesses) {
      const type = checker.getTypeAtLocation(read.argumentExpression)
      for (const member of type.isUnion() ? type.types : [type]) {
        if (member.isStringLiteral()) result.add(member.value)
      }
      if (ts.isPropertyAccessExpression(read.argumentExpression) && read.argumentExpression.name.text === "value") result.add("*")
    }
    if (isCall(item.initializer, "slotPart")) {
      const factory = referencedDeclaration(item.initializer.expression)
      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAccessExpression(node) && isSlots(node.expression)) result.add(node.name.text)
        ts.forEachChild(node, visit)
      }
      if (factory) visit(factory)
    }
    for (const render of scan.renders) {
      const [target, , children] = render.arguments
      if (!target || !children || !forwards(children)) continue
      const component = referencedDeclaration(target)
      if (component && isComponentDeclaration(component) && ts.isVariableDeclaration(component)) {
        for (const slot of collect(component, scanSource(component.getSourceFile(), component))) result.add(slot)
      } else {
        const keys = slotKeys(target)
        if (component && ts.isVariableDeclaration(component) && isCall(component.initializer, "useUIComponent")) {
          const name = component.initializer.arguments[0]
          if (name && ts.isStringLiteral(name) && name.text === "UButton") {
            for (const slot of ["default", "leading", "trailing", "*"]) keys.add(slot)
          }
        }
        if (!keys.size) keys.add("*")
        for (const slot of keys) result.add(slot)
      }
    }
    return result
  }
  return collect(declaration, sourceScan)
}

function isSlots(node: ts.Node | undefined): boolean {
  return !!node && ts.isIdentifier(node) && node.text === "slots"
}

function returns(block: ts.Block): ts.Expression[] {
  const result: ts.Expression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return
    if (ts.isReturnStatement(node) && node.expression) result.push(node.expression)
    else ts.forEachChild(node, visit)
  }
  visit(block)
  return result
}

function slotParameter(node: ts.Node): number | undefined {
  const fn = ts.isFunctionDeclaration(node) ? node : ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) ? node.initializer : undefined
  if (!fn) return undefined
  const names = fn.parameters.map((parameter) => (ts.isIdentifier(parameter.name) ? parameter.name.text : undefined))
  let index: number | undefined
  const visit = (child: ts.Node): void => {
    if (ts.isPropertyAssignment(child) && ts.isStringLiteral(child.name) && child.name.text === "data-slot" && ts.isIdentifier(child.initializer)) {
      const position = names.indexOf(child.initializer.text)
      if (position >= 0) index = position
    }
    ts.forEachChild(child, visit)
  }
  visit(fn)
  return index
}

function isComponentDeclaration(node: ts.Node): boolean {
  if (!ts.isVariableDeclaration(node) || !node.initializer || !ts.isCallExpression(node.initializer)) return false
  const callee = node.initializer.expression
  return ts.isIdentifier(callee) && (callee.text === "defineComponent" || callee.text === "slotPart")
}

function emitNames(declaration: ts.VariableDeclaration): string[] {
  const call = declaration.initializer
  if (!call || !ts.isCallExpression(call)) return []
  const options = call.arguments[0]
  if (!options || !ts.isObjectLiteralExpression(options)) return []
  for (const property of options.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || property.name.text !== "emits") continue
    const value = property.initializer
    if (ts.isArrayLiteralExpression(value)) return value.elements.flatMap((element) => (ts.isStringLiteral(element) ? [element.text] : []))
    if (ts.isObjectLiteralExpression(value)) {
      return value.properties.flatMap((item) => (item.name && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) ? [item.name.text] : []))
    }
  }
  return []
}
