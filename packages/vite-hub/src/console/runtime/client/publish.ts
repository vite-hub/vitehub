import type { ConsoleDocumentPublishExpectation, ConsoleDocumentsClient } from "./documents"

/**
 * Publishes reviewed changes of several collections, one publish per collection, and returns how many documents
 * changed. Each publish sends exactly the draft digests that the caller showed, so a draft saved since then fails with
 * a conflict and that collection publishes nothing. Collections publish in order and stop at the first failure.
 */
export async function publishConsoleDocumentChanges(
  client: Pick<ConsoleDocumentsClient, "publish">,
  changes: ReadonlyArray<{ change: ConsoleDocumentPublishExpectation, collection: string }>,
): Promise<number> {
  const byCollection = new Map<string, ConsoleDocumentPublishExpectation[]>()
  for (const { change, collection } of changes) {
    byCollection.set(collection, [...byCollection.get(collection) ?? [], { digest: change.digest, id: change.id }])
  }
  let count = 0
  for (const [collection, expect] of byCollection) count += (await client.publish(collection, expect)).documents.length
  return count
}
