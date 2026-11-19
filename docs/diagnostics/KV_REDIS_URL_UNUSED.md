KV does not select the Redis driver just because `REDIS_URL` is set or `KV_URL` contains a `rediss://` URL.

To use `REDIS_URL`, set the driver explicitly:

```ts
kv: { driver: "redis" }
```

To use `KV_URL`, set the driver and point it at that variable:

```ts
kv: { driver: "redis", url: "env:KV_URL" }
```

If KV should keep using its current store instead, set that store's driver explicitly.
