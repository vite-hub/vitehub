import { readonly, ref, type Ref } from "vue"

import { createMultipartUploader, uploadFiles } from "./client.ts"

import type { MultipartUploadOptions, SerializedBlobObject, UploadFilesOptions, UploadInput } from "./client.ts"

export type { MultipartUploadOptions, SerializedBlobObject, UploadFilesOptions, UploadInput } from "./client.ts"

export interface UseUploadOptions extends UploadFilesOptions {
  /** Resolve with an array. Set `false` to send one file and resolve with one object. Defaults to `true`. */
  multiple?: boolean
}

export interface UseMultipartUploadResult {
  /** Resolves with the stored object, or `undefined` when the upload was aborted. */
  completed: Promise<SerializedBlobObject | undefined>
  /** Upload progress from 0 to 100. */
  progress: Readonly<Ref<number>>
  abort: () => Promise<void>
}

/** Upload files to a route that returns the result of `blob.handleUpload()`. */
export function useUpload(apiBase: string, options?: UseUploadOptions & { multiple?: true }): (input: UploadInput) => Promise<SerializedBlobObject[]>
export function useUpload(apiBase: string, options: UseUploadOptions & { multiple: false }): (input: UploadInput) => Promise<SerializedBlobObject | undefined>
export function useUpload(apiBase: string, options: UseUploadOptions = {}): (input: UploadInput) => Promise<SerializedBlobObject[] | SerializedBlobObject | undefined> {
  const { multiple = true, ...uploadOptions } = options
  return async (input: UploadInput) => {
    const objects = await uploadFiles(apiBase, input, uploadOptions)
    return multiple ? objects : objects[0]
  }
}

/** Upload large files in parts to a route that returns the result of `blob.handleMultipartUpload()`. */
export function useMultipartUpload(baseURL: string, options: Omit<MultipartUploadOptions, "onProgress"> = {}): (file: File, pathname?: string) => UseMultipartUploadResult {
  return (file, pathname) => {
    const progress = ref(0)
    const task = createMultipartUploader(baseURL, { ...options, onProgress: (percent) => { progress.value = percent } })(file, pathname)
    return { abort: task.abort, completed: task.completed, progress: readonly(progress) }
  }
}
