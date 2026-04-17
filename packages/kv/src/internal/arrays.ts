export function pushUnique<T>(
  arr: T[],
  item: T,
  key: (value: T) => unknown = value => value,
): void {
  const id = key(item)
  if (arr.some(entry => key(entry) === id)) return
  arr.push(item)
}
