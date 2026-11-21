# Blob decisions

## Enforce the signed upload size without asking the browser to set Content-Length

`packages/blob/src/drivers/cloudflare-native.ts`, `packages/blob/src/drivers/cloudflare.ts`, and `packages/blob/src/runtime/signed.ts`.

**Context:** Browsers set `Content-Length` themselves. A proxied request can also omit it.

**Decision:** Sign the length for R2 but do not return it as a header for the client to set. When Blob proxies the upload, check the size as it reads the stream, even if the header is absent.

**Consequences:** A request that exceeds the limit or does not match an exact signed length must not store an object.

## Blob throws for every unknown store key

`config.ts` in `packages/blob/src`.

**Context:** A config object that a variable or another file builds skips TypeScript's check of unknown keys.

**Decision:** Throw for every key that is not `driver`, `remote`, or an option of the store's driver. An option set to `undefined` counts as omitted. With `stores`, each store holds its own driver options.

**Consequences:** A store without `driver` would silently ignore a driver option, such as `token` of a Vercel store.
