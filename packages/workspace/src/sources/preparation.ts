import type { SourceContext, WorkspaceSource } from "../core/types.ts"

const revisionResolutionByContext = new WeakMap<SourceContext, Promise<void>>()

export async function prepareWorkspaceSource(
  source: WorkspaceSource,
  ctx: SourceContext,
  options: { refreshRevision?: boolean } = {},
): Promise<void> {
  if (options.refreshRevision) {
    revisionResolutionByContext.delete(ctx)
    ctx.revision = undefined
  }
  let revisionResolution = revisionResolutionByContext.get(ctx)
  if (!revisionResolution) {
    revisionResolution = ctx.revision
      ? Promise.resolve()
      : (async () => {
          const revision = await source.resolveRevision?.(ctx)
          if (revision) ctx.revision = revision
        })()
    revisionResolutionByContext.set(ctx, revisionResolution)
  }
  await revisionResolution
  await source.prepare?.(ctx)
}
