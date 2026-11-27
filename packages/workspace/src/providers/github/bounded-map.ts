/** A Map that keeps the `limit` most recently used entries. */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly limit: number) {
    super();
  }

  override get(key: K): V | undefined {
    if (!super.has(key)) return undefined;
    const value = super.get(key)!;
    super.delete(key);
    super.set(key, value);
    return value;
  }

  override set(key: K, value: V): this {
    super.delete(key);
    super.set(key, value);
    for (const oldest of super.keys()) {
      if (this.size <= this.limit) break;
      super.delete(oldest);
    }
    return this;
  }
}
