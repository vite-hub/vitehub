import { useRegisteredWorkspace } from "./registry.ts"
import type { Workspace } from "./types.ts"

export async function useWorkspace(name: string): Promise<Workspace> {
  return await useRegisteredWorkspace(name)
}
