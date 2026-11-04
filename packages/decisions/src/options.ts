import type { ChoiceOption, ChoiceValue } from "./types.ts"

export interface ToOptionsMap<TItem, TValue extends ChoiceValue> {
  aliases?: (item: TItem) => readonly string[] | undefined
  label: (item: TItem) => string
  value: (item: TItem) => TValue
}

/** Maps your own items to options. This is the bridge from your data to Choices. */
export function toOptions<TItem, TValue extends ChoiceValue>(items: readonly TItem[], map: ToOptionsMap<TItem, TValue>): ChoiceOption<TValue>[] {
  return items.map((item) => {
    const aliases = map.aliases?.(item)
    return { label: map.label(item), value: map.value(item), ...(aliases?.length ? { aliases } : {}) }
  })
}
