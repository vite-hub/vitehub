import { FormSubmitError } from "./client.ts"
import { isFormDefinition } from "./define.ts"
import { formsDiagnostics } from "./errors.ts"
import { unwrap } from "./schema.ts"

import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import type { FormIssue } from "./client.ts"
import type { SchemaNode } from "./schema.ts"
import type { FormDefinition } from "./types.ts"

/** A form from `defineForm()`, or a plain Standard Schema, such as the input of an Agent tool. */
export type FormSource = FormDefinition | StandardSchemaV1

/** One field of a flat form: what every surface can draw, from a web form to a Slack modal. */
export interface FormField {
  name: string
  type: "string" | "number" | "integer" | "boolean"
  /** `v.title()`, or the JSON Schema `title`, else the name in words. */
  label: string
  description?: string
  required: boolean
  format?: "email" | "uri" | "date" | "date-time"
  /** The values of a choice, with their type. */
  options?: readonly (string | number)[]
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
}

/** A field that a surface cannot draw: its name, or `""` for the root, and what it is. */
interface FieldProblem {
  field: string
  found: string
}

const formats = new Set(["email", "uri", "date", "date-time"])
const longTextKeys = /^(message|details|description|text|body|comment|feedback|workflow|notes?)$/i

export function schemaOf(source: FormSource): StandardSchemaV1 {
  return isFormDefinition(source) ? source.options.schema : source
}

function humanize(key: string): string {
  const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** A string field that people write a few lines in: named like `message`, or longer than 200 characters. */
export function isLongText(field: Pick<FormField, "name" | "maxLength">): boolean {
  return longTextKeys.test(field.name) || (field.maxLength !== undefined && field.maxLength > 200)
}

const isChoice = (value: unknown): value is string | number => typeof value === "string" || typeof value === "number"
const read = (value: object, key: string): unknown => Reflect.get(value, key)
const readNumber = (value: object, key: string): number | undefined => {
  const found = read(value, key)
  return typeof found === "number" ? found : undefined
}
const readString = (value: object, key: string): string | undefined => {
  const found = read(value, key)
  return typeof found === "string" && found ? found : undefined
}

function optional<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>
}

function choiceType(options: readonly (string | number)[]): FormField["type"] {
  return options.every(option => typeof option === "string") ? "string" : "number"
}

function describeJsonType(property: object): string {
  const type = read(property, "type")
  if (type === "object") return "a nested object"
  if (type === "array") return "a list"
  if (Array.isArray(read(property, "anyOf")) || Array.isArray(read(property, "oneOf")) || Array.isArray(type)) return "a union of types"
  return typeof type === "string" ? `a ${type}` : "a value with no single type"
}

/** The options of a JSON Schema `enum`, or of an `anyOf` of `const` values, such as a Zod union of literals. */
function jsonOptions(property: object): (string | number)[] | undefined {
  const list = read(property, "enum")
  if (Array.isArray(list)) return list.every(isChoice) ? list : undefined
  const union = read(property, "anyOf") ?? read(property, "oneOf")
  if (!Array.isArray(union) || !union.length) return undefined
  const values = union.map((member: unknown) => member && typeof member === "object" ? read(member, "const") : undefined)
  return values.every(isChoice) ? values : undefined
}

function fromJsonSchema(schema: unknown): { fields: FormField[], problems: FieldProblem[] } {
  if (!schema || typeof schema !== "object" || read(schema, "type") !== "object") {
    return { fields: [], problems: [{ field: "", found: schema && typeof schema === "object" ? describeJsonType(schema) : "not a JSON Schema" }] }
  }
  const properties = read(schema, "properties")
  const required = read(schema, "required")
  const names = Array.isArray(required) ? required : []
  const fields: FormField[] = []
  const problems: FieldProblem[] = []
  for (const [name, property] of Object.entries(properties && typeof properties === "object" ? properties : {})) {
    if (!property || typeof property !== "object") continue
    const base = { name, label: readString(property, "title") ?? humanize(name), required: names.includes(name), ...optional({ description: readString(property, "description") }) }
    const options = jsonOptions(property)
    const type = read(property, "type")
    if (options) {
      fields.push({ ...base, type: choiceType(options), options })
    }
    else if (type === "string") {
      const format = readString(property, "format")
      fields.push({ ...base, type, ...optional({ format: format && formats.has(format) ? format as FormField["format"] : undefined, minLength: readNumber(property, "minLength"), maxLength: readNumber(property, "maxLength") }) })
    }
    else if (type === "number" || type === "integer") {
      fields.push({ ...base, type, ...optional({ minimum: readNumber(property, "minimum"), maximum: readNumber(property, "maximum") }) })
    }
    else if (type === "boolean") {
      fields.push({ ...base, type })
    }
    else problems.push({ field: name, found: describeJsonType(property) })
  }
  return { fields, problems }
}

const valibotKinds: Record<string, string> = {
  object: "a nested object",
  strict_object: "a nested object",
  loose_object: "a nested object",
  object_with_rest: "a nested object",
  record: "a record",
  array: "a list",
  tuple: "a list",
  union: "a union of types",
  variant: "a union of types",
  date: "a Date object",
  file: "a file",
  blob: "a file",
}

function fromValibot(root: SchemaNode): { fields: FormField[], problems: FieldProblem[] } {
  if (root.type !== "object" || !root.entries) return { fields: [], problems: [{ field: "", found: valibotKinds[root.type] ?? `a ${root.type} schema` }] }
  const fields: FormField[] = []
  const problems: FieldProblem[] = []
  for (const [name, entry] of Object.entries(root.entries)) {
    // `v.pipe(v.optional(v.string()), v.title("Name"))` keeps its title on the outer pipe.
    const { node, required, actions } = unwrap(entry)
    const action = (type: string) => actions.find(item => item.type === type)
    const requirement = (type: string) => {
      const value = action(type)?.requirement
      return typeof value === "number" ? value : undefined
    }
    const base = { name, label: action("title")?.title ?? humanize(name), required, ...optional({ description: action("description")?.description }) }
    if (node.type === "boolean") {
      fields.push({ ...base, type: "boolean" })
    }
    else if (node.type === "number") {
      fields.push({ ...base, type: action("integer") ? "integer" : "number", ...optional({ minimum: requirement("min_value"), maximum: requirement("max_value") }) })
    }
    else if (node.type === "picklist" || node.type === "enum") {
      // `options` of a Valibot enum holds its values without the reverse keys of a TypeScript numeric enum.
      const options = (node.options ?? []).filter(isChoice)
      fields.push({ ...base, type: choiceType(options), options })
    }
    else if (node.type === "string") {
      const format = action("email") ? "email" : action("url") ? "uri" : action("iso_date") ? "date" : action("iso_timestamp") ? "date-time" : undefined
      fields.push({ ...base, type: "string", ...optional({ format, minLength: requirement("min_length"), maxLength: requirement("max_length") }) })
    }
    else problems.push({ field: name, found: valibotKinds[node.type] ?? `a ${node.type} schema` })
  }
  return { fields, problems }
}

/** The fields that a surface can draw, and the fields that it cannot. */
export function collectFields(source: FormSource): { fields: FormField[], problems: FieldProblem[] } {
  const schema = schemaOf(source)
  const standard: StandardSchemaV1.Props & Partial<StandardJSONSchemaV1.Props> = schema["~standard"]
  if (standard.jsonSchema) return fromJsonSchema(standard.jsonSchema.input({ target: "draft-2020-12" }))
  // SAFETY: the vendor identifies Valibot, whose schemas are plain objects of this shape.
  if (standard.vendor === "valibot") return fromValibot(schema as unknown as SchemaNode)
  return { fields: [], problems: [{ field: "", found: `a ${standard.vendor} schema with no JSON Schema` }] }
}

/** Throws `FORMS_C0002` for a field that `surface` cannot draw. */
export function unsupportedField(problem: FieldProblem, surface: string, takes: string): Error {
  return formsDiagnostics.FORMS_C0002({ field: problem.field, found: problem.found, surface, takes })
}

/**
 * The fields of a flat form, in order, from a Valibot object schema, or from any Standard Schema with a Standard JSON
 * Schema, such as a Zod object. Each field is text, a number, a whole number, true or false, or a choice. Every
 * surface draws the same fields: a web form, an MCP elicitation, and a chat modal. Throws `FORMS_C0002` for a nested
 * object, a list, a union, or a root that is not an object.
 */
export function formFields(source: FormSource): FormField[] {
  const { fields, problems } = collectFields(source)
  const [problem] = problems
  if (problem) throw unsupportedField(problem, "A form", "a flat object of text, numbers, true or false, and choices")
  return fields
}

/** The value of a control, which is text, as the type of its field. `undefined` leaves the field out. */
export function decodeFieldValue(field: FormField, value: unknown): unknown {
  if (field.type === "boolean") {
    // A checkbox sends "on" when checked and nothing when not. A chat choice sends "true" or "false".
    if (value === undefined || value === "" || value === "false") return false
    return value === "on" || value === "true" ? true : value
  }
  if (typeof value !== "string") return value
  if (field.options) {
    const option = field.options.find(option => String(option) === value)
    // Leave out an empty placeholder. Keep valid empty choices and invalid values for validation.
    return option === undefined && value === "" ? undefined : option ?? value
  }
  if (field.type === "number" || field.type === "integer") return value === "" ? undefined : Number(value)
  return value
}

/**
 * Decodes the text of HTML controls to the types of the schema fields, in place: numbers, true or false, and choices.
 * Validation still checks every decoded value. Fields that no surface can draw stay as they are.
 */
export function coerceFormFields(schema: StandardSchemaV1, values: Record<string, unknown>): void {
  for (const field of collectFields(schema).fields) {
    const value = decodeFieldValue(field, values[field.name])
    if (value === undefined) delete values[field.name]
    else values[field.name] = value
  }
}

function issuePath(path: StandardSchemaV1.Issue["path"]): (string | number)[] {
  return (path ?? []).map((segment) => {
    const key = typeof segment === "object" ? segment.key : segment
    return typeof key === "number" ? key : String(key)
  })
}

/** Keep schema output in the same JSON representation for hooks, notifications, and both stores. */
function jsonData<T>(value: T): { value: T } | undefined {
  const ancestors = new Set<object>()
  const valid = (value: unknown): boolean => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true
    if (typeof value === "number") return Number.isFinite(value)
    if (typeof value !== "object" || ancestors.has(value)) return false
    const prototype: unknown = Object.getPrototypeOf(value)
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false
    ancestors.add(value)
    const values: unknown[] = Array.isArray(value) ? Array.from(value) : Object.values(value)
    const accepted = values.every(valid)
    ancestors.delete(value)
    return accepted
  }
  try {
    return valid(value) ? { value: JSON.parse(JSON.stringify(value)) as T } : undefined
  }
  catch {
    return undefined
  }
}

/**
 * Validates values with the schema of a form, the same check that the form route runs. Returns `[undefined, data]`
 * with the JSON output, or `[error]` where `error.issues` holds the problem of each field, as a 400 of the route.
 */
export async function checkForm<TSchema extends StandardSchemaV1>(source: FormDefinition<TSchema> | TSchema, values: unknown): Promise<[FormSubmitError, undefined] | [undefined, StandardSchemaV1.InferOutput<TSchema>]> {
  const schema = schemaOf(source)
  const result = await schema["~standard"].validate(values)
  if (result.issues) {
    return [new FormSubmitError("Check the form and try again.", 400, result.issues.map((issue): FormIssue => ({ message: issue.message, path: issuePath(issue.path) }))), undefined]
  }
  const data = jsonData(result.value as StandardSchemaV1.InferOutput<TSchema>)
  if (!data) return [new FormSubmitError("Check the form and try again.", 400, [{ message: "The form schema must return JSON data: plain objects, arrays, strings, finite numbers, booleans, or null.", path: [] }]), undefined]
  return [undefined, data.value]
}
