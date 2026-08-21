import type { Source, SourceContext } from "./types.ts"

interface KeyedSourceReader {
  get(key: never): Promise<unknown>
}

type RuntimeSourceDefinition<TReader extends KeyedSourceReader> =
  (context: SourceContext) => TReader

export function defineSource<const TSource extends Source>(source: TSource): TSource
export function defineSource<const TReader extends KeyedSourceReader>(source: TReader): TReader
export function defineSource<const TReader extends KeyedSourceReader>(
  definition: RuntimeSourceDefinition<TReader>,
): RuntimeSourceDefinition<TReader>
export function defineSource(
  source: Source | KeyedSourceReader | RuntimeSourceDefinition<KeyedSourceReader>,
) {
  return source
}

export function defineSources<const TSources extends Record<string, Source>>(sources: TSources): TSources {
  return sources
}

export function createSource<const TReader extends KeyedSourceReader>(
  definition: RuntimeSourceDefinition<TReader>,
  context: SourceContext,
): TReader {
  return definition(context)
}
