import { hasRuntimeType, isRuntimeRecord } from "./runtime-type.ts"

const providerPackageNames = new Set(["@vite-hub/agent", "vite-hub/agent"])
const capabilityPackageNames = new Set(["@vite-hub/agent/capabilities", "vite-hub/agent/capabilities"])
const providerFactoryNames = new Set(["codexDriver", "claudeCodeDriver"])
const providerCapabilityNames = new Set(["title", "progressSummary"])
const providerPresetPattern = /^(?:@vite-hub\/agent|vite-hub\/agent)\/presets\/(?:workspace|babysitter(?:\/server)?)$/
const providerKinds = new Set(["codex", "claude-code"])

interface PositionedNode {
  end: number
  start: number
  type: string
  [key: string]: unknown
}

function isPositionedNode(value: unknown): value is PositionedNode {
  return Boolean(
    value
    && isRuntimeRecord(value)
    && hasRuntimeType(value.type, "string")
    && hasRuntimeType(value.start, "number")
    && hasRuntimeType(value.end, "number"),
  )
}

function visitNodes(node: PositionedNode, visit: (node: PositionedNode) => void): void {
  visit(node)
  for (const value of Object.values(node)) {
    if (isPositionedNode(value)) visitNodes(value, visit)
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (isPositionedNode(item)) visitNodes(item, visit)
      }
    }
  }
}

function identifierName(value: unknown): string | undefined {
  return isPositionedNode(value) && value.type === "Identifier" && hasRuntimeType(value.name, "string") ? value.name : undefined
}

function literalString(value: unknown): string | undefined {
  return isPositionedNode(value) && value.type === "Literal" && hasRuntimeType(value.value, "string") ? value.value : undefined
}

function unwrapTypeScriptExpression(node: PositionedNode): PositionedNode {
  let expression = node
  while (
    expression.type === "TSAsExpression"
    || expression.type === "TSSatisfiesExpression"
    || expression.type === "TSNonNullExpression"
  ) {
    const inner = expression.expression
    if (!isPositionedNode(inner)) break
    expression = inner
  }
  return expression
}

function propertyName(node: PositionedNode): string | undefined {
  if (node.computed === true) return
  return identifierName(node.key) ?? literalString(node.key)
}

function importedBinding(specifier: PositionedNode): { imported: string, local: string } | undefined {
  if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") return
  const imported = identifierName(specifier.imported) ?? literalString(specifier.imported)
  const local = identifierName(specifier.local)
  return imported && local ? { imported, local } : undefined
}

function hasValueImport(specifier: unknown): boolean {
  return isPositionedNode(specifier) && specifier.importKind !== "type"
}

function collectAncestors(root: PositionedNode): Map<PositionedNode, PositionedNode[]> {
  const ancestors = new Map<PositionedNode, PositionedNode[]>()
  const visit = (node: PositionedNode, parents: PositionedNode[]) => {
    ancestors.set(node, parents)
    for (const value of Object.values(node)) {
      if (isPositionedNode(value)) visit(value, [...parents, node])
      else if (Array.isArray(value)) {
        for (const item of value) {
          if (isPositionedNode(item)) visit(item, [...parents, node])
        }
      }
    }
  }
  visit(root, [])
  return ancestors
}

function patternIdentifiers(node: unknown): string[] {
  if (!isPositionedNode(node)) return []
  if (node.type === "Identifier") return identifierName(node) ? [identifierName(node)!] : []
  if (node.type === "RestElement" || node.type === "TSParameterProperty") return patternIdentifiers(node.argument)
  if (node.type === "AssignmentPattern") return patternIdentifiers(node.left)
  if (node.type === "ObjectPattern") {
    return (Array.isArray(node.properties) ? node.properties : []).flatMap(property => {
      if (!isPositionedNode(property)) return []
      return property.type === "Property" ? patternIdentifiers(property.value) : patternIdentifiers(property.argument)
    })
  }
  if (node.type === "ArrayPattern") return (Array.isArray(node.elements) ? node.elements : []).flatMap(patternIdentifiers)
  return []
}

function isShadowedByFunctionBinding(
  node: PositionedNode,
  binding: string,
  ancestors: Map<PositionedNode, PositionedNode[]>,
): boolean {
  for (const ancestor of ancestors.get(node) ?? []) {
    if (ancestor.type === "ClassExpression" && identifierName(ancestor.id) === binding) return true
    if (
      ancestor.type !== "FunctionDeclaration"
      && ancestor.type !== "FunctionExpression"
      && ancestor.type !== "ArrowFunctionExpression"
    ) continue
    if (ancestor.type === "FunctionExpression" && identifierName(ancestor.id) === binding) return true
    const params = Array.isArray(ancestor.params) ? ancestor.params : []
    if (params.some(parameter => patternIdentifiers(parameter).includes(binding))) return true
  }
  return false
}

function declaredNames(node: PositionedNode): string[] {
  if (node.type === "VariableDeclaration") {
    return (Array.isArray(node.declarations) ? node.declarations : []).flatMap(declaration => {
      return isPositionedNode(declaration) ? patternIdentifiers(declaration.id) : []
    })
  }
  if (node.type === "ClassDeclaration" || node.type === "FunctionDeclaration") {
    const name = identifierName(node.id)
    return name ? [name] : []
  }
  return []
}

function hasHoistedVariable(node: PositionedNode, binding: string): boolean {
  if (
    node.type === "FunctionDeclaration"
    || node.type === "FunctionExpression"
    || node.type === "ArrowFunctionExpression"
    || node.type === "ClassDeclaration"
    || node.type === "ClassExpression"
  ) return false
  if (node.type === "VariableDeclaration" && node.kind === "var" && declaredNames(node).includes(binding)) return true
  for (const value of Object.values(node)) {
    if (isPositionedNode(value) && hasHoistedVariable(value, binding)) return true
    if (Array.isArray(value) && value.some(item => isPositionedNode(item) && hasHoistedVariable(item, binding))) return true
  }
  return false
}

function isShadowedByLexicalDeclaration(
  node: PositionedNode,
  binding: string,
  ancestors: Map<PositionedNode, PositionedNode[]>,
): boolean {
  for (const ancestor of ancestors.get(node) ?? []) {
    if (ancestor.type === "Program" && hasHoistedVariable(ancestor, binding)) return true
    if (
      ancestor.type === "FunctionDeclaration"
      || ancestor.type === "FunctionExpression"
      || ancestor.type === "ArrowFunctionExpression"
    ) {
      const body = ancestor.body
      if (isPositionedNode(body) && body.start <= node.start && node.end <= body.end && hasHoistedVariable(body, binding)) return true
    }
    if (ancestor.type === "StaticBlock" && hasHoistedVariable(ancestor, binding)) return true
    if (ancestor.type === "BlockStatement" || ancestor.type === "Program" || ancestor.type === "StaticBlock") {
      const statements = Array.isArray(ancestor.body) ? ancestor.body : []
      if (statements.some(statement => isPositionedNode(statement) && declaredNames(statement).includes(binding))) return true
    }
    if (ancestor.type === "ForStatement" || ancestor.type === "ForInStatement" || ancestor.type === "ForOfStatement") {
      if (isPositionedNode(ancestor.left) && declaredNames(ancestor.left).includes(binding)) return true
      if (isPositionedNode(ancestor.init) && declaredNames(ancestor.init).includes(binding)) return true
    }
    if (ancestor.type === "CatchClause" && patternIdentifiers(ancestor.param).includes(binding)) return true
    if (ancestor.type === "SwitchStatement") {
      const cases = Array.isArray(ancestor.cases) ? ancestor.cases : []
      // The discriminant runs outside the lexical environment shared by all cases.
      if (!cases.some(candidate => isPositionedNode(candidate) && candidate.start <= node.start && node.end <= candidate.end)) continue
      if (cases.some((candidate) => {
        const statements = isPositionedNode(candidate) && Array.isArray(candidate.consequent) ? candidate.consequent : []
        return statements.some(statement => isPositionedNode(statement) && declaredNames(statement).includes(binding))
      })) return true
    }
  }
  return false
}

function isProviderFactoryCall(
  node: PositionedNode,
  factoryBindings: Set<string>,
  namespaces: Set<string>,
  ancestors: Map<PositionedNode, PositionedNode[]>,
): boolean {
  if (node.type !== "CallExpression" || !isPositionedNode(node.callee)) return false
  if (node.callee.type === "Identifier") {
    const name = identifierName(node.callee) ?? ""
    return factoryBindings.has(name)
      && !isShadowedByFunctionBinding(node, name, ancestors)
      && !isShadowedByLexicalDeclaration(node, name, ancestors)
  }
  if (node.callee.type !== "MemberExpression" || node.callee.computed === true) return false
  const namespace = identifierName(node.callee.object) ?? ""
  return namespaces.has(namespace)
    && providerFactoryNames.has(identifierName(node.callee.property) ?? "")
    && !isShadowedByFunctionBinding(node, namespace, ancestors)
    && !isShadowedByLexicalDeclaration(node, namespace, ancestors)
}

function hasProviderDriverValue(node: PositionedNode): boolean {
  const value = unwrapTypeScriptExpression(node)
  if (value.type === "Literal") {
    const kind = literalString(value)
    return kind !== undefined && providerKinds.has(kind)
  }
  if (value.type !== "ObjectExpression") return false
  const properties = Array.isArray(value.properties) ? value.properties : []
  return properties.some((property) => {
    if (!isPositionedNode(property) || property.type !== "Property" || propertyName(property) !== "kind") return false
    const kind = isPositionedNode(property.value) ? literalString(unwrapTypeScriptExpression(property.value)) : undefined
    return kind !== undefined && providerKinds.has(kind)
  })
}

function objectProperty(node: PositionedNode, name: string): PositionedNode | undefined {
  if (node.type !== "ObjectExpression" || !Array.isArray(node.properties)) return
  const property = node.properties.find((candidate) => {
    return isPositionedNode(candidate) && candidate.type === "Property" && propertyName(candidate) === name
  })
  return isPositionedNode(property) && isPositionedNode(property.value) ? property.value : undefined
}

function isProviderCapabilityCall(
  node: PositionedNode,
  capabilityBindings: Set<string>,
  namespaces: Set<string>,
  ancestors: Map<PositionedNode, PositionedNode[]>,
): boolean {
  if (node.type !== "CallExpression" || !isPositionedNode(node.callee)) return false
  if (node.callee.type === "Identifier") {
    const name = identifierName(node.callee) ?? ""
    return capabilityBindings.has(name)
      && !isShadowedByFunctionBinding(node, name, ancestors)
      && !isShadowedByLexicalDeclaration(node, name, ancestors)
  }
  if (node.callee.type !== "MemberExpression" || node.callee.computed === true) return false
  const namespace = identifierName(node.callee.object) ?? ""
  return namespaces.has(namespace)
    && providerCapabilityNames.has(identifierName(node.callee.property) ?? "")
    && !isShadowedByFunctionBinding(node, namespace, ancestors)
    && !isShadowedByLexicalDeclaration(node, namespace, ancestors)
}

function hasProviderCapabilityDriver(
  node: PositionedNode,
  capabilityBindings: Set<string>,
  namespaces: Set<string>,
  ancestors: Map<PositionedNode, PositionedNode[]>,
): boolean {
  let found = false
  visitNodes(node, (descendant) => {
    if (found || !isProviderCapabilityCall(descendant, capabilityBindings, namespaces, ancestors)) return
    const options = Array.isArray(descendant.arguments) && isPositionedNode(descendant.arguments[0])
      ? unwrapTypeScriptExpression(descendant.arguments[0])
      : undefined
    const driver = options ? objectProperty(options, "driver") : undefined
    if (driver) found = hasProviderDriverValue(driver)
  })
  return found
}

function hasProviderDriverDefinition(
  node: PositionedNode,
  defineAgentBindings: Set<string>,
  namespaces: Set<string>,
  capabilityBindings: Set<string>,
  capabilityNamespaces: Set<string>,
  ancestors: Map<PositionedNode, PositionedNode[]>,
): boolean {
  if (node.type !== "CallExpression" || !isPositionedNode(node.callee)) return false
  const callee = node.callee
  const isDefineAgent = callee.type === "Identifier"
    ? defineAgentBindings.has(identifierName(callee) ?? "")
      && !isShadowedByFunctionBinding(node, identifierName(callee) ?? "", ancestors)
      && !isShadowedByLexicalDeclaration(node, identifierName(callee) ?? "", ancestors)
    : callee.type === "MemberExpression" && callee.computed !== true
      && namespaces.has(identifierName(callee.object) ?? "")
      && identifierName(callee.property) === "defineAgent"
      && !isShadowedByFunctionBinding(node, identifierName(callee.object) ?? "", ancestors)
      && !isShadowedByLexicalDeclaration(node, identifierName(callee.object) ?? "", ancestors)
  if (!isDefineAgent) return false
  const options = Array.isArray(node.arguments) && isPositionedNode(node.arguments[0])
    ? unwrapTypeScriptExpression(node.arguments[0])
    : undefined
  if (!options || options.type !== "ObjectExpression") return false
  const driver = objectProperty(options, "driver")
  if (driver && hasProviderDriverValue(driver)) return true
  const capabilities = objectProperty(options, "capabilities")
  return capabilities ? hasProviderCapabilityDriver(capabilities, capabilityBindings, capabilityNamespaces, ancestors) : false
}

/** Reports whether a server module selects a provider Agent Driver from statically recognizable syntax. */
export function usesProviderAgentDriver(source: string, parse: (source: string) => unknown): boolean {
  const parsed = parse(source)
  if (!isPositionedNode(parsed)) return false
  const program = parsed

  const factoryBindings = new Set<string>()
  const defineAgentBindings = new Set<string>()
  const namespaces = new Set<string>()
  const capabilityBindings = new Set<string>()
  const capabilityNamespaces = new Set<string>()
  let hasProviderPreset = false

  visitNodes(program, (node) => {
    if (node.type !== "ImportDeclaration" || node.importKind === "type") return
    const importedSource = literalString(node.source)
    if (!importedSource) return
    const specifiers = Array.isArray(node.specifiers) ? node.specifiers : []
    if (providerPresetPattern.test(importedSource)) {
      if (specifiers.some(hasValueImport)) hasProviderPreset = true
      return
    }
    if (!providerPackageNames.has(importedSource)) {
      if (!capabilityPackageNames.has(importedSource)) return
      for (const rawSpecifier of specifiers) {
        if (!isPositionedNode(rawSpecifier) || rawSpecifier.importKind === "type") continue
        if (rawSpecifier.type === "ImportNamespaceSpecifier") {
          const local = identifierName(rawSpecifier.local)
          if (local) capabilityNamespaces.add(local)
          continue
        }
        const binding = importedBinding(rawSpecifier)
        if (binding && providerCapabilityNames.has(binding.imported)) capabilityBindings.add(binding.local)
      }
      return
    }
    for (const rawSpecifier of specifiers) {
      if (!isPositionedNode(rawSpecifier) || rawSpecifier.importKind === "type") continue
      if (rawSpecifier.type === "ImportNamespaceSpecifier") {
        const local = identifierName(rawSpecifier.local)
        if (local) namespaces.add(local)
        continue
      }
      const binding = importedBinding(rawSpecifier)
      if (!binding) continue
      if (binding.imported === "defineAgent") defineAgentBindings.add(binding.local)
      if (providerFactoryNames.has(binding.imported)) factoryBindings.add(binding.local)
    }
  })
  if (hasProviderPreset) return true

  const ancestors = collectAncestors(program)
  let found = false
  visitNodes(program, (node) => {
    if (found) return
    found = isProviderFactoryCall(node, factoryBindings, namespaces, ancestors)
      || hasProviderDriverDefinition(node, defineAgentBindings, namespaces, capabilityBindings, capabilityNamespaces, ancestors)
  })
  return found
}

/** Worker builds resolve package imports with the "workerd" or "worker" condition. */
export function resolvesWorkerConditions(conditions: readonly string[] | undefined): boolean {
  return Boolean(conditions?.some(condition => condition === "workerd" || condition === "worker"))
}
