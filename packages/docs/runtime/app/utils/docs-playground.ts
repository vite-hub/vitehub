export function docsPlaygroundExampleQuery(examples: ReadonlyArray<{ id: string }>, id: string): string | undefined {
  return examples.length > 1 ? id : undefined
}
