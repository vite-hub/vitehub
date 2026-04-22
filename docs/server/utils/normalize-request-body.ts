const rawBody = Symbol("vitehub.raw-body")

export function normalizeRequestBody(request: any) {
  if (!request || typeof request.text === "function") {
    return
  }

  request.text = async () => {
    if (request[rawBody]) {
      return request[rawBody]
    }

    if (request.body !== undefined) {
      request[rawBody] = typeof request.body === "string" ? request.body : JSON.stringify(request.body)
      return request[rawBody]
    }

    request[rawBody] = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      request.on("error", reject)
      request.on("data", (chunk: Buffer | Uint8Array | string) => chunks.push(Buffer.from(chunk)))
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    })
    return request[rawBody]
  }
}
