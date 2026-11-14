---
title: Blob, KV, and Rate Limit commands
description: Read and write blobs and KV keys, and read or reset Rate Limit counters, on the dev server or on a deployed app with the vitehub CLI.
navigation.title: Blob, KV, Rate Limit
navigation.order: 4
navigation.group: Commands
icon: i-lucide-hard-drive
---

Start the dev server, then run these commands in another terminal. Each command runs an [operation](/docs/console/operations) of the app, so it uses the app's data. With `--url`, it runs on a deployed app with the Console on, with the credentials in [Call a deployed app](/docs/cli/operations#call-a-deployed-app).

## Read and write blobs

The `vitehub blob` commands run the `blob.*` operations.

```bash [Terminal]
pnpm vitehub blob list --prefix avatars/ --limit 20
pnpm vitehub blob head avatars/ada.png
pnpm vitehub blob get avatars/ada.png --output ./ada.png
pnpm vitehub blob get reports/2026.csv > report.csv
pnpm vitehub blob put avatars/ada.png ./ada.png --content-type image/png
pnpm vitehub blob delete avatars/ada.png
pnpm vitehub blob media avatars/ada.png
pnpm vitehub blob variants avatars/ada.png --json
```

Each write command prints what it changed:

```txt [Output]
Created blob avatars/ada.png in store default (48213 B, image/png).
Deleted blob avatars/ada.png from store default.
```

Every command takes `--store <name>`, `--json`, `--url <url>` for a deployed app, and `--timeout <ms>`. The default Blob store is used unless you pass `--store`. Store names come from `blob.stores`. An unknown store fails and lists the stores, `default` first.

- `list` prints pathname, size, content type, and upload time. `--limit` defaults to 100, at most 250. When more blobs exist, stderr shows the `--cursor` for the next page.
- `head` prints one blob's metadata. A missing blob exits with status 1.
- `get` writes the bytes unchanged, to stdout by default, so redirect them. `--output <file>` writes the file and prints a summary. `--json` needs `--output`.
- `put` uploads a file relative to the current directory. Without `--content-type`, Blob storage guesses the type from the pathname. The output says if the blob was created or replaced. This label is a best guess from a metadata read just before the write, so eventual consistency and concurrent writers can make it wrong.
- `media` prints the blob's [media record](/docs/blob/media). A missing record is built from the object and stored, as `blob.media.get()` does. A missing blob exits with status 1.
- `variants` lists a blob's cached image variants and crop replacements, with transform key, type, and size.
- `put` and `delete` refuse paths under `_vitehub/` (`BLOB_RESERVED_PATH`), which ViteHub keeps for itself. `get` and `head` can read them. The CLI replaces an existing blob without asking. The Console asks first (`overwrite: false` makes `blob.put` fail with `BLOB_EXISTS`).
- `delete` says if the blob existed, which is a best guess for the same reason. Deleting a missing blob changes nothing and exits with status 0.

Files travel as base64 in a JSON call, so `put` and `get` handle up to 8 MiB. The CLI checks an upload's size before it reads the file. Larger blobs fail with `BLOB_UPLOAD_TOO_LARGE` or `BLOB_DOWNLOAD_TOO_LARGE`, so use the app or your provider's tools. There is no `sign` command. `list` shows every object, including those under `_vitehub/` that the Console hides by default.

Errors go to stderr, or to `{ "error": { "code", "message" } }` on stdout with `--json`. The commands print no object URLs, because a signed URL can carry credentials. `media` prints the record's served route URL, which carries none. Metadata values under secret names, such as `token`, are redacted.

The operations are `blob.list`, `blob.head`, `blob.get`, `blob.put`, `blob.delete`, `blob.media`, and `blob.variants`, in the `blob` Console section. They run in the Nitro runtime and answer through the Console RPC, so you need access to the `blob` section. `blob.put` writes and `blob.delete` is destructive. `vitehub blob delete` asks for confirmation on a terminal and refuses elsewhere. Scripts pass `--yes` (or `-y`). The Console Blob page uses the same operations.

## Read and write KV keys

The `vitehub kv` commands run the `kv.*` operations.

```bash [Terminal]
pnpm vitehub kv list --prefix users: --limit 20
pnpm vitehub kv get settings
pnpm vitehub kv has settings
pnpm vitehub kv set settings '{"theme":"dark"}' --json-value
pnpm vitehub kv set session:42 active --ttl 3600
pnpm vitehub kv set template @./fixtures/template.txt
pnpm vitehub kv delete settings
```

Each write command prints what it changed:

```txt [Output]
Created key settings in store default (object).
Created key session:42 in store default (string, TTL 3600 s).
Deleted key settings from store default.
```

Every command takes `--store <name>`, `--json`, `--url <url>` when Vite does not listen on `http://localhost:5173`, and `--timeout <ms>`. Commands use the default KV store. `--store` picks a named store from `kv.stores`. An unknown store fails and lists the stores, `default` first.

- `list` prints one key per line. Use `--json` when keys contain line breaks. `--limit` defaults to 100, at most 1000. When more keys exist, stderr shows the `--cursor` for the next page. Some drivers count scanned entries toward the limit, so a page can hold fewer keys, or none, and still have a next cursor.
- `get` writes a string value unchanged, with no added newline, and other JSON values as formatted JSON. Binary values go to stdout as bytes, or as base64 with `"encoding": "base64"` in `--json` output. A missing key exits with status 1.
- `has` exits with status 0 when the key exists and 1 when it does not.
- `set` writes a string. `--json-value` parses the value as JSON. JSON input rejects values that underflow to zero or whose decimal size changes when parsed, so use strings for those and for integers outside JavaScript's safe range. A value that starts with `@` reads a UTF-8 file relative to the current directory. The output says if the key was created or updated.
- `--ttl <seconds>` on `set` sets an expiry, and takes positive fractional seconds. Cloudflare KV rounds up to whole seconds, at least 60. Upstash needs at least one second and rounds up to whole seconds. The output shows the real TTL and a notice when the driver changes it.
- `delete` says if the key was found. Deleting a missing key changes nothing and exits with status 0.

KV storage parses stored strings that look like JSON, so `"2026"` can read back as the number `2026`. There is no `clear` command, so each delete is explicit.

Errors go to stderr, or to `{ "error": { "code", "message" } }` on stdout with `--json`. Like the Console KV page, the commands print values as stored, without redaction. Do not store credentials in keys you inspect in shared logs.

The operations are `kv.list`, `kv.get`, `kv.has`, `kv.set`, and `kv.delete`, in the `kv` Console section. They run in the Nitro runtime and answer through the Console RPC, so you need access to the `kv` section. `kv.delete` is destructive: `vitehub kv delete` asks for confirmation on a terminal and refuses elsewhere. Scripts pass `--yes` (or `-y`). The Console KV page uses the same operations.

## Read and reset Rate Limit counters

Read or reset one key's counter of a Rate Limit from `requireRateLimit()`:

```bash [Terminal]
pnpm vitehub rate-limit peek <id> <key>
pnpm vitehub rate-limit reset <id> <key> [--yes]
```

`<id>` is the stable ID of `requireRateLimit()`. `<key>` is the limited key, such as a client IP or user ID. Put `--` before a key that starts with a dash. Both commands take `--json`, `--url <url>`, and `--timeout <ms>`. Without `--url`, they call this project's dev server. With `--url https://app.example.com`, they call a deployed app with the [Console](/docs/console) on, and sign with `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>`.

The commands run `rate-limit.peek` (a read) and `rate-limit.reset` in the `rate-limits` Console section. `reset` is destructive: it asks for confirmation on a terminal and refuses elsewhere, so scripts pass `--yes`. The Console **Rate Limits** page uses the same operations.

- The memory provider keeps counters in the server process, so you see only the counters of the process that answers.
- The Cloudflare binding has only `limit()`, which uses a token, so both commands report `unsupported` and exit with status 1.
