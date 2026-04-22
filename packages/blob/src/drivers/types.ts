import type { BlobListOptions, BlobListResult, BlobObject, BlobPutOptions } from "../types.ts"

export type BlobPutBody = string | ReadableStream<unknown> | ArrayBuffer | ArrayBufferView | Blob

export interface BlobDriverAdapter<TOptions> {
  name: string
  options: TOptions
  delete(pathnames: string | string[]): Promise<void>
  get(pathname: string): Promise<Blob | null>
  getArrayBuffer(pathname: string): Promise<ArrayBuffer | null>
  head(pathname: string): Promise<BlobObject | null>
  list(options?: BlobListOptions): Promise<BlobListResult>
  put(pathname: string, body: BlobPutBody, options?: BlobPutOptions): Promise<BlobObject>
}
