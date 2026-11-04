---
title: Decisions limits and errors
description: The limits of Choices and the error code of each failure.
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

`resolve()` asks one question for each option of a `multiple` group, one for each single group, and one `supported` check. A hundred options are a hundred questions. The gateway sends large sets in bounded requests.

Two thresholds decide the answers. Change them with `thresholds`.

| Threshold | Default | Decides |
| --- | --- | --- |
| `option` | 0.5 | Whether one option is included, excluded, or chosen. |
| `supported` | 0.6 | Whether the options can express the text at all. |

A decision model answers from the options you gave it. It can match names, codes, abbreviations, prefixes, and typos. It cannot compare numbers, and it cannot invent a value.

## Errors

`resolve()` and `inspect()` return `[error, data]`. A wrong definition throws when you call `defineChoices()`. Each error has a `code`.

### DECISIONS_R0001

The definition is wrong: no gateway with `ask()`, no group, a group without a label, or a threshold outside 0 to 1. Fix the definition.

### DECISIONS_R0002

The options are over a limit or invalid. Nothing was asked. Narrow the options, give every value once in its group, and give every option a label. In a `multiple: false` group, labels must be unique and cannot be `(none)`. This code also covers an `options` function that threw. The `cause` has its error.

### DECISIONS_R0003

The text is empty or longer than `limits.text`. Nothing was asked.

### DECISIONS_R0004

The model says the options cannot express the text. Show the person a message and let them use your normal controls.

### DECISIONS_R0005

The gateway request failed. The `cause` has the gateway error, such as a rejected key. See [AI gateways](/docs/agents/ai-gateways#errors).

### DECISIONS_R0006

The model answer misses a question that was asked. Try again.
