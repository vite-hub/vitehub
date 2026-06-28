import type { WorkspaceSource } from "../core/types.ts"

type SourceScopes<T> = T extends { scopes?: infer TScopes } ? { scopes?: TScopes } : {}
type TypedWorkspaceSource<T> = WorkspaceSource & SourceScopes<T>

export function custom<const TSource extends WorkspaceSource>(source: TSource): TypedWorkspaceSource<TSource> {
  return source as unknown as TypedWorkspaceSource<TSource>
}
