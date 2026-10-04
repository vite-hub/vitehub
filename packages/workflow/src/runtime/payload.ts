import { workflowErrorDiagnostics } from "../error-diagnostics.ts"
interface PayloadSchema<T> {
  safeParse: (payload: unknown) => { success: boolean, data?: T, error?: unknown }
}

interface ParsePayloadSchema<T> {
  parse: (payload: unknown) => T
}

type PayloadValidator<T> =
  | PayloadSchema<T>
  | ParsePayloadSchema<T>
  | ((payload: unknown) => T | Promise<T>)

export async function readRequestPayload<T = unknown>(request: Request): Promise<T> {
  const contentType = request.headers.get("content-type") || ""
  if (contentType.includes("application/json")) {
    return await request.json() as T
  }
  return await request.text() as T
}

export async function validatePayload<T>(payload: unknown, schema: PayloadValidator<T>): Promise<T> {
  if (typeof schema === "function") {
    return await schema(payload)
  }

  if (hasSchemaMethod(schema, "safeParse") && typeof (schema as { safeParse?: unknown }).safeParse === "function") {
    const result = (schema as PayloadSchema<T>).safeParse(payload)
    if (!result.success) {
      throw result.error || workflowErrorDiagnostics.WORKFLOW_R0021({ message: "Invalid workflow payload." })
    }
    return result.data as T
  }

  if (hasSchemaMethod(schema, "parse") && typeof (schema as { parse?: unknown }).parse === "function") {
    return (schema as ParsePayloadSchema<T>).parse(payload)
  }

  throw workflowErrorDiagnostics.WORKFLOW_R0022({ message: "Invalid workflow payload schema." })
}

function hasSchemaMethod(value: object, key: "parse" | "safeParse"): boolean {
  if (Object.hasOwn(value, key)) return true
  let prototype = Object.getPrototypeOf(value)
  // Each realm's Object.prototype is a root prototype with a null parent.
  while (prototype !== null && Object.getPrototypeOf(prototype) !== null) {
    if (Object.hasOwn(prototype, key)) {
      const constructor = Object.hasOwn(prototype, "constructor") ? prototype.constructor : undefined
      return typeof constructor === "function" && constructor.prototype === prototype
    }
    prototype = Object.getPrototypeOf(prototype)
  }
  return false
}

export async function readValidatedPayload<T>(request: Request, schema: PayloadValidator<T>): Promise<T> {
  return await validatePayload<T>(await readRequestPayload(request), schema)
}
