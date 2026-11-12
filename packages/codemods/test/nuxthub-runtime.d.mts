export function serveMigratedRoute(code: string, directory: string): Promise<{ response: Response, missing: Response }>
export function blobBindings(options: { driver: "cloudflare-r2", binding: string, bucketName: string, jurisdiction: "eu" }): Array<{ binding: string, bucket_name: string, jurisdiction?: string }> | undefined
export function readLocalKV(directory: string, binding: string): Promise<unknown>
