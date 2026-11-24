---
title: env-spec-v1 profile
navigation.title: Schema file
description: The annotations, types, defaults, and names that envSchema() reads from a committed .env.example.
navigation.order: 7.5
icon: i-lucide-file-text
---

`envSchema()` reads a committed `.env.example` and makes one Env declaration for each key. It reads `env-spec-v1`, a limited profile of the [@env-spec comment syntax](https://varlock.dev/env-spec/reference/). This page lists what the profile accepts. To add `envSchema()` to your config, read [Import an environment schema](/docs/env/configure#import-an-environment-schema).

The reader only reads static text. It does not load your `.env` files, run Varlock, fetch secrets, or evaluate expansions and functions.

## Example

```dotenv [.env.example]
# @defaultRequired=true @defaultSensitive=true
# ---

# The shop name in the page header.
# @public
VITEHUB_PUBLIC_SHOP_NAME=Northwind Coffee

# @type=enum(debug, info, warn, error) @public
VITEHUB_LOG_LEVEL=info

# @type=number(min=1, max=10, isInt=true) @public
VITEHUB_ORDER_RETRIES=3

# @type=url @example="postgres://shop:password@localhost:5432/shop"
VITEHUB_DATABASE_URL=
```

| Key | Read it with | Type |
| --- | --- | --- |
| `VITEHUB_PUBLIC_SHOP_NAME` | `usePublicEnv().shopName` | `string` |
| `VITEHUB_LOG_LEVEL` | `useServerEnv().logLevel` | `"debug" \| "info" \| "warn" \| "error"` |
| `VITEHUB_ORDER_RETRIES` | `useServerEnv().orderRetries` | `number` |
| `VITEHUB_DATABASE_URL` | `useServerEnv().databaseUrl` | `SecretEnv<string>` |

## Annotations

Put annotations in the comment lines directly above a key, with no empty line between them. A comment line without `@` is a note for people.

| Annotation | Effect |
| --- | --- |
| `@type=<type>` | Sets the type. Without it, the type is `string`. See [Types](#types). |
| `@required`, `@optional` | A required field needs a host value when it has no default. An optional field can be missing. Fields are required by default. |
| `@sensitive`, `@public` | The value is a secret, or it is not. Fields are sensitive by default. |
| `@example="<text>"` | Shows a sample value. It never becomes the default. |

An annotation without a value means `true`. Write `=false` to reverse it: `@optional=false` is the same as `@required`. One key cannot have both `@required` and `@optional`, or both `@sensitive` and `@public`.

To change the defaults for the whole file, put `@defaultRequired` and `@defaultSensitive` at the top, above a `# ---` divider line. Their value must be `true` or `false`.

The reader rejects other annotations, an annotation used twice on one key, an annotation that is not attached to a key, and an annotation value that is not static.

## Types

| Type | Value |
| --- | --- |
| `string`, `string(minLength=1, maxLength=80)` | A string. The length limits are inclusive. A required string cannot be empty. |
| `number`, `number(min=0, max=100, isInt=true)` | A finite decimal number. `isInt=true` requires a safe integer. |
| `boolean` | `true` from `true` or `1`, `false` from `false` or `0`. |
| `enum(draft, send)` | One of the listed strings. Each choice must be a nonempty, unique string. |
| `url` | An absolute URL, checked with the `URL` constructor. The value stays a string. |
| `array`, `array(string)` | A JSON array. With an item type, each item must match it. |
| `object`, `object(enabled=boolean, retries=number)` | A JSON object. With properties, the object must have exactly these properties. |

Types can nest up to 16 levels, such as `array(object(name=string, scores=array(number)))`. A sensitive field cannot contain an `enum`, because the choices would show the possible secret values. Use `string`, or mark the field `@public`.

## Defaults

The text after `=` is the default.

- `KEY=` has no default.
- `KEY=value` is a real default. The reader checks it against the type when the config loads, and the build fails if it does not match.
- `KEY=""` is an empty string. A required field rejects it. An optional `string` field accepts it when it has no `minLength` or `minLength=0`. For other optional types, it means no default.
- The reader trims unquoted text: `KEY=  text  ` gives `text`. Quotes keep the exact text, with its spaces.
- A `string` default keeps its digits, so `CODE=00123` keeps its zeroes.
- A `number` default is a decimal number, such as `3`, `2.5`, or `1e3`. `0xff`, `NaN`, and `Infinity` fail.
- Put a JSON default in single quotes: `ROLES='["read","write"]'`.

The reader rejects `$OTHER`, `${OTHER}`, `$(command)`, function calls such as `fetchSecret(name)`, and unquoted `[` or `{`. Double quotes do not change this: `KEY="${OTHER}"` fails. Single quotes keep the text as it is, so `KEY='${OTHER}'` is the literal text `${OTHER}`. Put sample values in `@example`, not in the assignment.

## Host values

Env checks the value that the host sets against the same type.

- An empty value, such as `VITEHUB_LOG_LEVEL=` on the host, is missing. The default applies. Without a default, a required field fails and an optional field is `undefined`.
- A value that does not match the type fails. It does not fall back to the default.
- A string value for an `array` or `object` field is JSON text. A host value that is already an array or object, such as a Cloudflare JSON variable, is used as it is.

## Names and sections

The default prefix is `VITEHUB_`. Change it with `envSchema(file, { prefix: "APP_" })`.

| Key | Section | When Env reads it |
| --- | --- | --- |
| `<prefix>PUBLIC_*`, not sensitive | Public Env, readable in browser code | When you build |
| Every other key | Server Env, for server code only | When the server runs |

- A key that starts with `<prefix>PUBLIC_` goes to the browser when it is not sensitive. The file default `@defaultSensitive=false` is enough, so the key does not need its own `@public`. Without that default, mark the key `@public` or `@sensitive=false`. A sensitive public key fails.
- `@public` on another key only clears the secret flag. The value stays in Server Env.
- A sensitive Server Env value is a `SecretEnv<T>`. `.unseal()` returns the parsed value of type `T`, such as a `number` for `@type=number`.
- With `prefix: ""`, `PUBLIC_*` keys go to Public Env.

The name in code drops `<prefix>PUBLIC_` from a Public Env key and `<prefix>` from a Server Env key, and uses camel case: `VITEHUB_ORDER_RETRIES` becomes `orderRetries`. With the default prefix, `PUBLIC_SHOP_NAME` does not start with `VITEHUB_PUBLIC_`, so it stays in Server Env as `publicShopName`. To put a Server Env value in a group, map its exact key with `paths`: `{ paths: { VITEHUB_DATABASE_URL: "database.url" } }`. Public Env names stay flat. A path fails when a part is not a safe identifier, when its first part is `public`, `define`, or `server`, or when it overlaps another path. A `paths` key that the file does not declare fails too.

Each field reads only its own key. `VITEHUB_DATABASE_URL` mapped to `database.url` still reads `VITEHUB_DATABASE_URL`, and no other name can override it.

A key can have letters, digits, and `_`, cannot start with a digit, and can have up to 256 characters. `__proto__`, `prototype`, and `constructor` are reserved. Each key can appear once.

## Errors

A schema file that the profile does not accept fails when the config loads, with `ENV_DECLARATION_INVALID`. Its message only says `[vitehub] Env declaration is invalid.`, so read the error `cause`. The cause names the file, the line, and the reason, and the key when the reader can find it. A syntax error such as `VALUE="unclosed` has no key.
