import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import * as v from "valibot"

const checkoutRecord = v.object({ head: v.pipe(v.string(), v.regex(/^[\da-f]{40}(?:[\da-f]{24})?$/i)) })
const recordPath = (root: string) => join(root, ".git", "vitehub-provider-checkout.json")

/**
 * Marks `root` as a Git checkout that the host prepared at commit `head`. A provider Driver that
 * starts in an Agent-owned Workspace at `root` then keeps the checkout's Git history, and fails
 * if HEAD moved before it starts.
 */
export async function recordProviderCheckout(root: string, head: string): Promise<void> {
  await writeFile(recordPath(root), JSON.stringify(v.parse(checkoutRecord, { head })))
}

export async function preparedProviderCheckoutHead(root: string): Promise<string | undefined> {
  const record = await readFile(recordPath(root), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    return undefined
  })
  return record === undefined ? undefined : v.parse(checkoutRecord, JSON.parse(record)).head
}
