---
title: AI Gateways limits and errors
description: Know the size limit and retries of ask(), and fix each GATEWAYS error code.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Limits

`gateway.ask()` sends the questions in a sequence of size-limited requests:

- The shared state plus each question must be under 30,000 bytes.
- It retries up to two times on network failure or a 408, 429, 500, 502, 503, or 504 answer.

## Errors

Every error has a `code`, a `why`, and a `fix`. Errors from `ask()` keep the provider error as `cause`.

### GATEWAYS_R0001

The gateway definition is not valid, such as an unknown option or a non-http(s) URL. It throws when you call the preset.

### GATEWAYS_R0002

A key is missing or empty. The message names the variable to set, or `apiKey` when you passed it.

### GATEWAYS_R0003

A header value is missing, empty, or has a line break.

### GATEWAYS_R0004

A URL, Cloudflare account ID, or AI Gateway ID is missing or not valid, or the gateway does not serve the Driver or model API.

### GATEWAYS_R0005

`ask()` was called on a gateway that only routes model requests.

### GATEWAYS_R0006

`ask()` needs the `advocaat` package. Install it with `pnpm add advocaat`.

### GATEWAYS_R0007

A Jev question that the `ask` builders do not make, or one that is too large.

### GATEWAYS_R0008

The provider rejected the key with 401 or 403. `status` is 503, with `providerStatus` and `requestId`. The `fix` names the variable to rotate.

### GATEWAYS_R0009

The provider still failed after three attempts. `status` is 502, with `providerStatus` and `requestId`.

### GATEWAYS_R0010

`languageModel()` needs the AI SDK provider package of its model API. The message names the package.

### GATEWAYS_R0011

`askWithModel()` needs the `ai` package. Install it with `pnpm add ai`.

### GATEWAYS_R0012

The model of `askWithModel()` answered a question with a value that is not one of its options.
