import { blob } from "@vite-hub/blob"

export default async () => {
  const [error, result] = await blob.list()
  if (error) throw error
  return Response.json(result)
}
