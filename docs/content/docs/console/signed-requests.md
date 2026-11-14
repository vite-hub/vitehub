---
title: Signed Console requests
description: Make an Ed25519 key pair for the CLI or CI, sign calls to the Console endpoint of your app, and rotate or revoke one key at a time.
navigation.title: Signed requests
navigation.order: 21
navigation.group: Secure it
icon: i-lucide-key-round
---

Every call to the Console endpoint carries an Ed25519 signature, so reading the host env or a pulled `.env` file is not enough to call it. Each caller has its own key pair, such as one per Console link and one for the CLI in CI, and the app keeps only the public keys in `VITEHUB_CONSOLE_KEY_<NAME>` variables. The build contains no keys.

## Make a key for the CLI

The [Console](/docs/console/get-started#link-a-deployed-app) gives you the line for its own key. For the CLI, make a key pair:

```bash [Terminal]
pnpm vitehub secret console-key ci
# The app: set this variable on the deployment.
VITEHUB_CONSOLE_KEY_CI=<public key>
# The CLI: keep this one secret, such as in a CI secret. Remove the app variable to revoke it.
VITEHUB_CONSOLE_PRIVATE_KEY_CI=<private key>
```

Set the public key on the server, such as with `wrangler secret put VITEHUB_CONSOLE_KEY_CI` on Cloudflare. It is 43 base64url characters, the raw 32 bytes of the Ed25519 key, and `<NAME>` holds capital letters, digits and underscores. The server reads the variables on each request.

Set the private key where the CLI runs, and every command with `--url` signs with it:

```bash [Terminal]
VITEHUB_CONSOLE_PRIVATE_KEY_CI=<private key> vitehub logs list --url https://app.example.com
```

The CLI signs with the `<NAME>` of its one `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>` variable. Two of them are an error.

::warning
The holder of a private key decides which person it signs as, so trust the person as much as the key. Keep private keys out of source code and client bundles.
::

## Give each caller its own key

```bash [Terminal]
VITEHUB_CONSOLE_KEY_CONSOLE_3F9A12BC=<console public key> \
VITEHUB_CONSOLE_KEY_CI=<ci public key> \
node .output/server/index.mjs
```

Hosts never give a secret back, so one variable per caller lets a command add or remove its own key without reading the others, and removing one variable revokes only that caller.

To rotate with no downtime, add the public key of a new pair under a new name and deploy, give the caller the new private key, then remove the old variable and deploy again. The old key stops working at once.

## Set the app origin

The signature covers the app origin, so a request signed for one app, such as a preview, fails on another app with the same key. The origin comes from `vitehub({ publicUrl })` when it is set. On Node.js it is required, because Node.js adapters build the request URL from the caller's `Host`, and signed requests without a matching origin fail with `500 CONSOLE_SIGNATURE_ORIGIN`. Use the string form for one deployment origin; the function form permits its configured Agent origins. Other hosts can use the request URL as the platform routed it. Forwarding headers never set the origin.

A signature is valid for 5 minutes, and within them the same request can run again on the same app. TLS keeps others from reading it.

## Sign calls to a development server

```bash [Terminal]
VITEHUB_CONSOLE_PRIVATE_KEY_CI=<private key> vitehub kv list --url http://localhost:3000
```

Without `--url`, a command calls its project's dev server unsigned, which a dev server with `console: true` rejects. Pass `--url` with the dev server's origin, put the public key in the dev server's environment, and on Node also set `publicUrl` to that origin. To skip keys in development, set `auth: false` for the [dev server](/docs/console/development) only.

## The signature format

| Header | Value |
| --- | --- |
| `x-vitehub-signature` | `key=<NAME>, t=<seconds>, origin=<app origin>, body=<SHA-256>, v1=<signature>` |
| `x-vitehub-caller` | Base64url JSON of the caller: `{"via":"cli"}`, or `{"via":"console","user":{...},"team":{...}}` from the Console. |

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

The path and query are the ones that the app receives, with any mount, such as `/portal/_vitehub/rpc`. Signed requests reach only `POST /_vitehub/rpc`.

The server checks in this order, and each refusal is `401` with a code and a fix:

| Code | Why |
| --- | --- |
| `CONSOLE_SIGNATURE_MISSING` | The request has no signature. A bearer token or a cookie does not count. |
| `CONSOLE_SIGNATURE_STALE` | The time is more than 5 minutes before or after the app clock. |
| `CONSOLE_SIGNATURE_ORIGIN` | The request was signed for another origin. |
| `CONSOLE_KEY_UNKNOWN` | The app has no `VITEHUB_CONSOLE_KEY_<NAME>` for the name in the signature. |
| `CONSOLE_SIGNATURE_INVALID` | The signature does not match: another key, another path, another person, or a malformed header. |
| `CONSOLE_SIGNATURE_BODY` | The body is not the body that was signed. |

A `401` carries `WWW-Authenticate: VitehubSignature realm="vitehub-console"`. With no key variable set, every request gets `500` with `CONSOLE_KEY_NOT_CONFIGURED`, and with one that is not a key, `500` with `CONSOLE_KEY_MALFORMED`, naming the variable.
