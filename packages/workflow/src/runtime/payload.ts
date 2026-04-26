export async function readRequestPayload<T = unknown>(request: Request): Promise<T> {
  const contentType = request.headers.get("content-type") || ""
  if (contentType.includes("application/json")) {
    return await request.json() as T
  }

  const text = await request.text()
  return text as T
}

export async function validatePayload<T>(payload: unknown, schema: { parse?: (payload: unknown) => T, safeParse?: (payload: unknown) => { success: boolean, data?: T, error?: unknown } } | ((payload: unknown) => T)): Promise<T> {
  if (typeof schema === "function") {
    return schema(payload)
  }

  if (typeof schema.safeParse === "function") {
    const result = schema.safeParse(payload)
    if (!result.success) {
      throw result.error || new TypeError("Invalid workflow payload.")
    }
    return result.data as T
  }

  if (typeof schema.parse === "function") {
    return schema.parse(payload)
  }

  throw new TypeError("`readValidatedPayload()` requires a parser function or schema with parse/safeParse.")
}

export async function readValidatedPayload<T>(request: Request, schema: Parameters<typeof validatePayload<T>>[1]): Promise<T> {
  return await validatePayload<T>(await readRequestPayload(request), schema)
}
