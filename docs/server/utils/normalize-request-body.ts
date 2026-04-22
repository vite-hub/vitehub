const rawBodyPromise = Symbol("vitehub.rawBodyPromise")

type RequestLike = {
  body?: unknown
  on?: (event: string, listener: (...args: any[]) => void) => RequestLike
  text?: () => Promise<string>
  json?: () => Promise<unknown>
  arrayBuffer?: () => Promise<ArrayBuffer>
  [rawBodyPromise]?: Promise<Buffer>
}

function toBuffer(body: unknown) {
  if (body == null) {
    return Buffer.alloc(0)
  }

  if (Buffer.isBuffer(body)) {
    return body
  }

  if (typeof body === "string") {
    return Buffer.from(body)
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body)
  }

  if (body instanceof ArrayBuffer) {
    return Buffer.from(body)
  }

  if (body instanceof URLSearchParams) {
    return Buffer.from(body.toString())
  }

  return Buffer.from(JSON.stringify(body))
}

function readNodeBody(request: RequestLike) {
  if (request[rawBodyPromise]) {
    return request[rawBodyPromise]
  }

  if ("body" in request && request.body !== undefined) {
    request[rawBodyPromise] = Promise.resolve(toBuffer(request.body))
    return request[rawBodyPromise]
  }

  if (typeof request.on !== "function") {
    request[rawBodyPromise] = Promise.resolve(Buffer.alloc(0))
    return request[rawBodyPromise]
  }

  request[rawBodyPromise] = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []

    request.on!("error", reject)
      .on!("data", (chunk: Buffer | Uint8Array | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      .on!("end", () => {
        resolve(Buffer.concat(chunks))
      })
  })

  return request[rawBodyPromise]
}

export function normalizeRequestBody(request: RequestLike | null | undefined) {
  if (!request || typeof request.text === "function") {
    return
  }

  request.text = async () => (await readNodeBody(request)).toString("utf8")
  request.json = async () => JSON.parse(await request.text())
  request.arrayBuffer = async () => {
    const body = await readNodeBody(request)
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
  }
}
