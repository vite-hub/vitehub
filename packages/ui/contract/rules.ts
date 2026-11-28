import { kebab } from "./report.ts"
import type { ApiComponent, ApiProp, ApiReport } from "./report.ts"

export interface Violation {
  component: string
  rule: ContractRule
  prop?: string
}

export type ContractRule =
  | "any-type"
  | "as-prop"
  | "boolean-default-true"
  | "class-prop"
  | "color-prop"
  | "data-state"
  | "emits-type"
  | "icon-string"
  | "model-without-default"
  | "negative-boolean"
  | "props-type"
  | "root-data-slot"
  | "size-values"
  | "slots-type"
  | "tone-values"
  | "ui-prop"
  | "update-without-prop"
  | "variant-values"

export const vocabulary = {
  size: ["xs", "sm", "md", "lg"],
  tone: ["neutral", "success", "warning", "error", "info"],
  variant: ["solid", "outline", "soft", "ghost", "link", "destructive"],
} as const

const isBoolean = (prop: ApiProp) => /^boolean(?: \| undefined)?$/.test(prop.type)
const capitalize = (value: string) => value.replace(/^./, (char) => char.toUpperCase())

function propRules(prop: ApiProp): ContractRule[] {
  const rules: ContractRule[] = []
  if (prop.name === "ui") rules.push("ui-prop")
  if (prop.name.endsWith("Class")) rules.push("class-prop")
  if (prop.name === "color") rules.push("color-prop")
  if (prop.name === "as") rules.push("as-prop")
  if ((prop.name === "icon" || prop.name.endsWith("Icon")) && /\bstring\b/.test(prop.type)) rules.push("icon-string")
  if (isBoolean(prop) && /^(?:no|hide|disable)[A-Z]/.test(prop.name)) rules.push("negative-boolean")
  if (isBoolean(prop) && prop.default === "true") rules.push("boolean-default-true")
  if (/\bany\b/.test(prop.type)) rules.push("any-type")
  if (prop.name === "variant" || prop.name === "size" || prop.name === "tone") {
    const allowed: readonly string[] = vocabulary[prop.name]
    if (!prop.values || prop.values.some((value) => !allowed.includes(value))) rules.push(`${prop.name}-values`)
  }
  return rules
}

export function componentViolations(component: ApiComponent): Violation[] {
  const found: Violation[] = []
  const add = (rule: ContractRule, prop?: string) => found.push(prop === undefined ? { component: component.name, rule } : { component: component.name, rule, prop })
  const props = new Set(component.props.map((prop) => prop.name))

  for (const prop of component.props) for (const rule of propRules(prop)) add(rule, prop.name)
  for (const event of component.events) {
    if (!event.name.startsWith("update:")) continue
    const key = event.name.slice("update:".length)
    if (!props.has(key)) add("update-without-prop", key)
    const defaultKey = key === "modelValue" ? "defaultValue" : `default${capitalize(key)}`
    if (!props.has(defaultKey)) add("model-without-default", key)
  }
  if (!component.types.includes(`${component.name}Props`)) add("props-type")
  if (component.events.length && !component.types.includes(`${component.name}Emits`)) add("emits-type")
  if (component.slots.length && !component.types.includes(`${component.name}Slots`)) add("slots-type")
  if (!component.rootDataSlots.includes(kebab(component.name))) add("root-data-slot")
  if (component.dataAttributes.includes("data-state")) add("data-state")
  return found
}

export function contractViolations(report: ApiReport): Violation[] {
  return sortViolations(report.components.flatMap(componentViolations))
}

export const violationKey = (violation: Violation) => `${violation.component} ${violation.rule}${violation.prop === undefined ? "" : ` ${violation.prop}`}`

export function sortViolations(violations: Violation[]): Violation[] {
  return [...violations].sort((a, b) => (violationKey(a) < violationKey(b) ? -1 : violationKey(a) > violationKey(b) ? 1 : 0))
}
