import type { BlobBody, BlobListOptions, BlobListResult, BlobObject, BlobPutOptions } from "../types.ts"

export type BlobPutBody = BlobBody | File

export interface BlobDriver<TOptions> {
  delete(pathnames: string | string[]): Promise<void>
  get(pathname: string): Promise<Blob | null>
  getArrayBuffer(pathname: string): Promise<ArrayBuffer | null>
  head(pathname: string): Promise<BlobObject | null>
  list(options?: BlobListOptions): Promise<BlobListResult>
  name: string
  options: TOptions
  put(pathname: string, body: BlobPutBody, options?: BlobPutOptions): Promise<BlobObject>
}
