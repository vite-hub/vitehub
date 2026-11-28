## How to fix it

- In `vitehub()`, set `kv: true` for the default store, `kv: { driver: 'redis' }` to choose a driver, or `kv: false` to turn KV off.
- In a standalone app, call `hubKV()` for the default store, `hubKV({ driver: 'redis' })` to choose a driver, or `hubKV(false)` to turn KV off.
- If the error names `kv.stores`, pass an object of named stores that includes `default`, such as `kv: { stores: { default: { driver: 'redis' } } }`. In `hubKV()`, pass that same options object directly.
