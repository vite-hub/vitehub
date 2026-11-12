---
title: Decisions limits and errors
description: Read Choices limits, set thresholds for answers, and fix each Decisions error code.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Limits

Change them with `limits` in `defineChoices()`.

| Limit | Default |
| --- | --- |
| Groups | 40 |
| Options in one group | 100 |
| Options in all groups | 100 |
| Text length | 300 characters |

`resolve()` asks one question per multi-select option, one per non-empty single-select group, and one `supported` check. So 100 options make 101 questions in a multi-select group, but two in a single-select group. The gateway splits large sets into bounded requests.

Two thresholds decide the answers. Change them with `thresholds`.

| Threshold | Default | Decides |
| --- | --- | --- |
| `option` | 0.5 | Whether one option is included, excluded, or chosen. |
| `supported` | 0.6 | Whether the options can express the text. |

A decision model answers only from your options. It matches names, codes, abbreviations, prefixes, and typos. It cannot compare numbers or invent a value.

## Errors

`resolve()` and `inspect()` return `[error, data]`. `defineChoices()` throws on a wrong definition. Each error has a `code`.

### DECISIONS_R0001

The definition is wrong: no gateway with `ask()` and no `model`, or both, no group, a group without a label, or a threshold outside 0 to 1. Fix the definition.

### DECISIONS_R0002

The options are over a limit or invalid, so nothing was asked. Use fewer options, unique values per group, and a label on each. In a `multiple: false` group, labels must be unique and not `(none)`. A throwing `options` function also gives this code, with its error in `cause`.

### DECISIONS_R0003

The text is empty or longer than `limits.text`, so nothing was asked.

### DECISIONS_R0004

The model says the options cannot express the text. Show a message and let the person use your normal controls. Groups with `infer: true` never cause this error.

### DECISIONS_R0005

The gateway request failed. For known, client-safe gateway diagnostics, the `message` gives the reason, such as a missing or rejected API key or a missing `advocaat` package, and `fix` gives the gateway fix when it has one. Other custom, provider, model, or abort failures use a generic message. The `cause` keeps the original error for server-side inspection; do not send it to the client. See [AI gateways](/docs/gateways/limits-and-errors#errors).

### DECISIONS_R0006

The model answer skipped a question. Try again.
