const MAX_CURSOR_HISTORIES = 1_024

type CursorHistory = Set<string>

/** Keeps continuation history independent of local filters and bounds abandoned pages. */
export function createCursorHistory() {
  const byCursor = new Map<string, CursorHistory[]>()
  const insertionOrder: Array<{ cursor: string, history: CursorHistory }> = []

  function take(cursor: string): CursorHistory {
    const histories = byCursor.get(cursor)
    if (!histories?.length) return new Set<string>()
    const history = histories.shift()!
    if (histories.length === 0) byCursor.delete(cursor)
    const index = insertionOrder.findIndex(entry => entry.cursor === cursor && entry.history === history)
    if (index >= 0) insertionOrder.splice(index, 1)
    return history
  }

  function store(cursor: string, history: CursorHistory) {
    const histories = byCursor.get(cursor)
    if (histories) histories.push(history)
    else byCursor.set(cursor, [history])
    insertionOrder.push({ cursor, history })
    while (insertionOrder.length > MAX_CURSOR_HISTORIES) {
      const oldest = insertionOrder.shift()!
      const current = byCursor.get(oldest.cursor)
      if (!current) continue
      const index = current.indexOf(oldest.history)
      if (index >= 0) current.splice(index, 1)
      if (current.length === 0) byCursor.delete(oldest.cursor)
    }
  }

  return { take, store }
}
