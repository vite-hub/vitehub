import type { Driver } from "unstorage"

/** How many single-key calls `getMany()` and `setMany()` run at once on a store without a batch command. */
export const kvBatchConcurrency = 16

/** Runs `run` for each item, at most `limit` at once, and keeps the input order. */
export async function mapWithLimit<TItem, TResult>(items: readonly TItem[], run: (item: TItem) => Promise<TResult>, limit = kvBatchConcurrency): Promise<TResult[]> {
  const results: TResult[] = Array.from({ length: items.length })
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++
      results[index] = await run(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** Splits `items` into arrays of at most `size` items. */
export function chunks<TItem>(items: readonly TItem[], size: number): TItem[][] {
  const result: TItem[][] = []
  for (let offset = 0; offset < items.length; offset += size) result.push(items.slice(offset, offset + size))
  return result
}

type DriverGetItems = NonNullable<Driver["getItems"]>
type DriverSetItems = NonNullable<Driver["setItems"]>

/** `getItems()` for a driver without a batch read: one `getItem()` per key, at most {@link kvBatchConcurrency} at once. */
export function getItemsOneByOne(driver: Driver): DriverGetItems {
  return (items, commonOptions) => mapWithLimit(items, async item => ({
    key: item.key,
    value: await driver.getItem(item.key, { ...commonOptions, ...item.options }),
  }))
}

/** `setItems()` for a driver without a batch write: one `setItem()` per entry, at most {@link kvBatchConcurrency} at once. */
export function setItemsOneByOne(driver: Driver): DriverSetItems {
  return async (items, commonOptions) => {
    await mapWithLimit(items, async item => driver.setItem?.(item.key, item.value, { ...commonOptions, ...item.options }))
  }
}
