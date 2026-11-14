---
title: Blob, KV, and Rate Limit commands
description: Read and write blobs and KV keys, and read or reset Rate Limit counters, on the dev server or on a deployed app with the vitehub CLI.
navigation.title: Blob, KV, Rate Limit
navigation.order: 4
navigation.group: Commands
icon: i-lucide-hard-drive
---

These commands let you look at and fix the data your app stores, from a terminal. Start the dev server and run them in another terminal, or pass `--url` to work on a deployed app with the Console on, as [Call a deployed app](/docs/cli/operations#call-a-deployed-app) describes. They use the same [operations](/docs/console/operations) as the Console pages, so you need access to the matching Console section: `blob`, `kv`, or `rate-limits`.

## Read and write blobs

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

Each write prints what it changed:

```txt [Output]
Created blob avatars/ada.png in store default (48213 B, image/png).
Deleted blob avatars/ada.png from store default.
```

| Command | What it does |
| --- | --- |
| `list` | Prints pathname, size, content type, and upload time, every object included, also those under `_vitehub/` that the Console hides. `--limit` defaults to 100, at most 250. When more exist, stderr shows the `--cursor` of the next page. |
| `head` | Prints one blob's metadata. A missing blob exits with status 1. |
| `get` | Writes the bytes unchanged to stdout, so redirect them, or to `--output <file>` with a summary. `--json` needs `--output`. |
| `put` | Uploads a file relative to the current directory and says if the blob was created or replaced. Without `--content-type`, the type comes from the pathname. It replaces an existing blob without asking. |
| `delete` | Says if the blob existed. Deleting a missing blob exits with status 0. It asks first on a terminal and refuses elsewhere, so scripts pass `--yes` (or `-y`). |
| `media` | Prints the blob's [media record](/docs/blob/media), with its served route URL. A missing record is built and stored, as `blob.media.get()` does. |
| `variants` | Lists cached image variants and crop replacements, with transform key, type, and size. |

Every command takes `--store <name>` (a name from `blob.stores`, else the default store), `--json`, `--url`, and `--timeout <ms>`. An unknown store fails and lists the stores. Errors go to stderr, or to `{ "error": { "code", "message" } }` on stdout with `--json`.

Files travel as base64 in a JSON call, so `get` and `put` stop at 8 MiB with `BLOB_DOWNLOAD_TOO_LARGE` or `BLOB_UPLOAD_TOO_LARGE`. Use the app or your provider's tools for bigger files. `put` and `delete` refuse paths under `_vitehub/`, which ViteHub keeps for itself (`BLOB_RESERVED_PATH`). The output never shows object URLs or a `sign` command, because a signed URL can carry credentials, and metadata values under secret names such as `token` are redacted.

## Read and write KV keys

```bash [Terminal]
pnpm vitehub kv list --prefix users: --limit 20
pnpm vitehub kv get settings
pnpm vitehub kv has settings
pnpm vitehub kv set settings '{"theme":"dark"}' --json-value
pnpm vitehub kv set session:42 active --ttl 3600
pnpm vitehub kv set template @./fixtures/template.txt
pnpm vitehub kv delete settings
```

```txt [Output]
Created key settings in store default (object).
Created key session:42 in store default (string, TTL 3600 s).
Deleted key settings from store default.
```

| Command | What it does |
| --- | --- |
| `list` | Prints one key per line, so use `--json` when keys contain line breaks. `--limit` defaults to 100, at most 1000, and stderr shows the next `--cursor`. Some drivers count scanned entries, so a page can hold fewer keys, or none, and still have a cursor. |
| `get` | Writes a string unchanged with no added newline, other JSON values formatted, and binary values as bytes (base64 with `"encoding": "base64"` in `--json`). A missing key exits with status 1. |
| `has` | Exits with status 0 when the key exists and 1 when it does not. |
| `set` | Writes a string and says if the key was created or updated. `--json-value` parses JSON, and a value that starts with `@` reads a UTF-8 file. `--ttl <seconds>` sets an expiry in positive seconds, fractions allowed, and the output shows the real TTL when the driver changes it. |
| `delete` | Says if the key was found. Deleting a missing key exits with status 0. It asks first on a terminal and refuses elsewhere, so scripts pass `--yes` (or `-y`). |

Every command takes `--store <name>` (a name from `kv.stores`, else the default store), `--json`, `--url`, and `--timeout <ms>`. There is no `clear` command, so each delete is explicit.

KV storage parses stored strings that look like JSON, so `"2026"` can read back as the number `2026`. `--json-value` rejects numbers that underflow to zero or lose precision, so store those, and integers past JavaScript's safe range, as strings. Cloudflare KV rounds a TTL up to whole seconds, at least 60, and Upstash rounds up to whole seconds, at least 1.

::warning
The commands print values as stored, without redaction, like the Console KV page. Do not keep credentials in keys that you read in shared logs.
::

## Read and reset Rate Limit counters

Read or reset one key's counter of a Rate Limit from `requireRateLimit()`:

```bash [Terminal]
pnpm vitehub rate-limit peek <id> <key>
pnpm vitehub rate-limit reset <id> <key> [--yes]
```

`<id>` is the stable ID of `requireRateLimit()`, and `<key>` is the limited key, such as a client IP or a user ID. Put `--` before a key that starts with a dash. `peek` reads without using a token. `reset` deletes the counter, so it asks first on a terminal and refuses elsewhere without `--yes`. Both take `--json`, `--url`, and `--timeout <ms>`.

The memory provider keeps counters in the server process, so you see only the process that answers. The Cloudflare binding has only `limit()`, which uses a token, so both commands report `unsupported` and exit with status 1.
