# Blob decisions

## Enforce the signed upload size without asking the browser to set Content-Length

`packages/blob/src/drivers/cloudflare-native.ts`, `packages/blob/src/drivers/cloudflare.ts`, and `packages/blob/src/runtime/signed.ts`.

**Context:** Browsers set `Content-Length` themselves. A proxied request can also omit it.

**Decision:** Sign the length for R2 but do not return it as a header for the client to set. When Blob proxies the upload, check the size as it reads the stream, even if the header is absent.

**Consequences:** A request that exceeds the limit or does not match an exact signed length must not store an object.
