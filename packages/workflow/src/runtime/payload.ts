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

  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- SAFETY: The structural union may lack safeParse; reject non-callable parser properties before calling it.
  if (hasSchemaMethod(schema, "safeParse") && typeof (schema as { safeParse?: unknown }).safeParse === "function") {
    // SAFETY: The guard verifies an allowed callable method; PayloadValidator<T> owns its result contract.
    const result = (schema as PayloadSchema<T>).safeParse(payload)
    if (!result.success) {
      throw result.error || workflowErrorDiagnostics.WORKFLOW_R0021({ message: "Invalid workflow payload." })
    }
    return result.data as T
  }

  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- SAFETY: The structural union may lack parse; reject non-callable parser properties before calling it.
  if (hasSchemaMethod(schema, "parse") && typeof (schema as { parse?: unknown }).parse === "function") {
    // SAFETY: The guard verifies an allowed callable method; PayloadValidator<T> owns its result contract.
    return (schema as ParsePayloadSchema<T>).parse(payload)
  }

  throw workflowErrorDiagnostics.WORKFLOW_R0022({ message: "Invalid workflow payload schema." })
}

function hasSchemaMethod<T>(value: PayloadSchema<T> | ParsePayloadSchema<T>, key: "parse" | "safeParse"): boolean {
  if (Object.hasOwn(value, key)) return true
  let prototype = Object.getPrototypeOf(value)
  while (prototype !== null) {
    if (Object.hasOwn(prototype, key)) {
      const constructor = Object.hasOwn(prototype, "constructor") ? prototype.constructor : undefined
      // Native Object constructors have the same source across realms. Custom
      // constructor prototypes can also have a null parent and remain valid.
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Prototype linkage requires a callable constructor before inspecting its prototype.
      return typeof constructor === "function"
        && constructor.prototype === prototype
        && Function.prototype.toString.call(constructor) !== Function.prototype.toString.call(Object)
    }
    prototype = Object.getPrototypeOf(prototype)
  }
  return false
}

export async function readValidatedPayload<T>(request: Request, schema: PayloadValidator<T>): Promise<T> {
  return await validatePayload<T>(await readRequestPayload(request), schema)
}
