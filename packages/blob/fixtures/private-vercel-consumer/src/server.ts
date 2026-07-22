import { blob } from "@vite-hub/blob"

export default async () => Response.json(await blob.list())
