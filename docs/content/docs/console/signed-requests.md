---
title: Signed Console requests
description: Make an Ed25519 key pair for the CLI or CI, sign calls to the Console endpoint of your app, and rotate or revoke one key at a time.
navigation.title: Signed requests
navigation.order: 21
navigation.group: Secure it
icon: i-lucide-key-round
---

The Console endpoint lets in only signed requests. Each caller has an Ed25519 key pair: the ViteHub Console has one for each linked app, and the CLI or a CI job has its own. The app keeps only the public keys, in `VITEHUB_CONSOLE_KEY_<NAME>` variables. A person or tool that reads the host env, or a pulled `.env` file, cannot sign a request. The build does not contain the keys.

## Make a key for the CLI

To link an app in the [ViteHub Console](/docs/console/get-started#link-a-deployed-app), set the line that its setup page shows. For the CLI, make a key pair:

```bash [Terminal]
pnpm vitehub secret console-key ci
# The app: set this variable on the deployment.
VITEHUB_CONSOLE_KEY_CI=<public key>
# The CLI: keep this one secret, such as in a CI secret. Remove the app variable to revoke it.
VITEHUB_CONSOLE_PRIVATE_KEY_CI=<private key>
```

Set the first line on the server, such as `wrangler secret put VITEHUB_CONSOLE_KEY_CI` on Cloudflare. A key is 43 base64url characters, the raw 32 bytes of the Ed25519 public key. `<NAME>` has capital letters, digits, and underscores. The server reads the variables on each request.

Set the second line where the CLI runs. A command with `--url` signs each call with it:

```bash [Terminal]
VITEHUB_CONSOLE_PRIVATE_KEY_CI=<private key> vitehub logs list --url https://app.example.com
```

The CLI reads one `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>` variable, and `<NAME>` is the name that it signs with. Two of them is an error.

::warning
The holder of a private key decides which person it signs. Trust the person as much as the key. Keep private keys out of source code and client bundles.
::

## Give each caller its own key

Each caller has its own `VITEHUB_CONSOLE_KEY_<NAME>` variable, such as one for each Console link and one for the CLI in CI:

```bash [Terminal]
VITEHUB_CONSOLE_KEY_CONSOLE_3F9A12BC=<console public key> \
VITEHUB_CONSOLE_KEY_CI=<ci public key> \
node .output/server/index.mjs
```

Hosts never give a secret back, so a command can add or remove its own variable without reading the others. Removing one variable revokes only that caller.

To rotate a key with no downtime, make a key pair with a new name, add its public key to the app, and deploy. Give the new private key to the caller, then remove the old variable and deploy again. The old key stops working at once.

## Set the app origin

The signature covers the app origin. The origin stops a request signed for one app, such as a preview, from working on another app with the same key.

The app origin is the origin of `vitehub({ publicUrl })` when it is set. Node.js adapters build the request URL from `Host`, which the caller controls, so signed requests on Node require `publicUrl`. Without a matching configured origin, they fail with `500 CONSOLE_SIGNATURE_ORIGIN`. Use the string form for one deployment origin. The function form permits its configured Agent origins. Other hosts can use the request URL as the platform routed it. Forwarding headers never supply the app origin.

Inside the 5 minutes that a signature is valid, the same request can run again on the same app. TLS keeps others from reading it.

## Sign calls to a development server

A command without `--url` calls the dev server of its project and does not sign, so a dev server with `console: true` rejects it. Pass `--url` with the origin of the dev server. On Node, also set `publicUrl` to that origin in the development configuration. The dev server also needs the public key in its environment:

```bash [Terminal]
VITEHUB_CONSOLE_PRIVATE_KEY_CI=<private key> vitehub kv list --url http://localhost:3000
```

To use the commands without a key during development, set `auth: false` for the dev server only. See [Development server](/docs/console/development).

## The signature format

Each signed request has two headers:

- `x-vitehub-signature: key=<NAME>, t=<seconds>, origin=<app origin>, body=<SHA-256>, v1=<signature>`
- `x-vitehub-caller: <base64url JSON>`, who calls: `{"via":"cli"}`, or `{"via":"console","user":{...},"team":{...}}` from the Console.

The signature is Ed25519 over these lines, joined with a line feed:

```txt
vitehub-signature-v1
POST
/_vitehub/rpc
https://app.example.com
1794400000
CI
<SHA-256 of the exact body bytes, base64url>
<the x-vitehub-caller header>
```

The second line is the method. The third line is the path and query that the app receives, with an application mount such as `/portal/_vitehub/rpc`. The fifth line is the time in seconds. Signed requests reach only `POST /_vitehub/rpc`.

The server checks the request in this order. Every refusal is `401` with a code and a fix:

| Code | Why |
| --- | --- |
| `CONSOLE_SIGNATURE_MISSING` | The request has no signature. A bearer token or a cookie does not count. |
| `CONSOLE_SIGNATURE_STALE` | The time is more than 5 minutes before or after the app clock. |
| `CONSOLE_SIGNATURE_ORIGIN` | The request was signed for another origin than this app. |
| `CONSOLE_KEY_UNKNOWN` | The app has no `VITEHUB_CONSOLE_KEY_<NAME>` for the name in the signature. |
| `CONSOLE_SIGNATURE_INVALID` | The signature does not match: another key, another path, another person, or a malformed header. |
| `CONSOLE_SIGNATURE_BODY` | The body is not the body that was signed. |

When no key variable is set, every request gets `500` with `CONSOLE_KEY_NOT_CONFIGURED`. When one of them is not a key, every request gets `500` with `CONSOLE_KEY_MALFORMED`, and the message names it. A `401` carries `WWW-Authenticate: VitehubSignature realm="vitehub-console"`.
