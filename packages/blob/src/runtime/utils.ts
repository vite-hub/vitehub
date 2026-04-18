import mime from "mime"

export function getContentType(pathname: string): string {
  return mime.getType(pathname) || "application/octet-stream"
}

export function normalizePutBody(body: Blob | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array> | string): Blob | ArrayBuffer | ReadableStream<Uint8Array> | string {
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice().buffer
  }

  return body
}
