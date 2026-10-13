import type { StandardSchemaV1 } from "@standard-schema/spec"

import { sourceErrorDiagnostics } from "../error-diagnostics.ts"

export async function parseCollectionSchema<TOutput>(schema: StandardSchemaV1<unknown, TOutput>, value: unknown): Promise<TOutput> {
  const result = await schema["~standard"].validate(value)
  if (result.issues) throw sourceErrorDiagnostics.SOURCE_R0006({ message: result.issues[0]?.message ?? "Collection value is invalid." })
  return result.value
}
