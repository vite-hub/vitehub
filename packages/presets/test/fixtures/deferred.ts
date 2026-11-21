export function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(finish => { resolve = finish; });
  return { promise, resolve };
}
