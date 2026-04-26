export interface PayloadSchema<T> {
  safeParse: (payload: unknown) => { success: boolean, data?: T, error?: unknown }
}

export async function readRequestPayload<T = unknown>(request: Request): Promise<T> {
  const contentType = request.headers.get("content-type") || ""
  if (contentType.includes("application/json")) {
    return await request.json() as T
  }
  return await request.text() as T
}

export async function validatePayload<T>(payload: unknown, schema: PayloadSchema<T>): Promise<T> {
  const result = schema.safeParse(payload)
  if (!result.success) {
    throw result.error || new TypeError("Invalid workflow payload.")
  }
  return result.data as T
}

export async function readValidatedPayload<T>(request: Request, schema: PayloadSchema<T>): Promise<T> {
  return await validatePayload<T>(await readRequestPayload(request), schema)
}
