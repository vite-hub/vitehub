---
title: Installation
description: Learn how to configure Better Auth in your project.
navigation: false
icon: i-lucide-terminal
---

::steps{level="2"}

## Install the Package

Let's start by adding Better Auth to your project:

::code-group

```bash [npm]
npm install better-auth
```

```bash [pnpm]
pnpm add better-auth
```

```bash [yarn]
yarn add better-auth
```

```bash [bun]
bun add better-auth
```

::

::callout{icon="i-lucide-info" color="info"}
If you're using a separate client and server setup, make sure to install Better Auth in both parts of your project.
::

## Set Environment Variables

Create a `.env` file in the root of your project and add the following environment variables:

### Secret Key

A secret value used for encryption and hashing. It must be at least 32 characters and generated with high entropy. You can also use `openssl rand -base64 32` to generate one.

```bash [.env]
BETTER_AUTH_SECRET=
```

::u-button
Generate Secret
::

## Create a Better Auth Instance

Create an auth instance in your server code.

```ts [auth.ts]
import { betterAuth } from 'better-auth'

export const auth = betterAuth({
  database: {
    provider: 'sqlite',
  },
})
```

## Configure Database

Connect the auth instance to your database adapter.

```ts [auth.ts]
export const auth = betterAuth({
  database: db,
})
```

## Create Database Tables

Generate the tables required by your adapter.

## Authentication Methods

Enable the methods your app should expose.

## Mount Handler

Expose the auth handler from your framework route.

## Create Client Instance

Create the browser client used by your app.

## That's it!

The auth flow is ready to use.

::
