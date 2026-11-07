---
title: Decisions concepts
description: "Learn the Decisions words: choices, groups, options, and selection. See why the model cannot invent a value, and where each part runs."
navigation.title: Concepts
navigation.order: 8
navigation.group: Concepts
icon: i-lucide-lightbulb
---

Decisions turns a sentence into a choice among things you list. ViteHub asks a model which ones the sentence means, and you get a typed answer.

## The mental model

You write the options and the route. ViteHub asks the model and checks the answer. You apply the selection.

```text
your data → options → defineChoices() → resolve(text) → selection → your state
            (bridge in)                  (ViteHub)                   (bridge out)
```

Decisions has no routes, UI, or store. Only your two bridges connect it to your app.

## Choices, groups, and options

`defineChoices()` returns a **choices** object. It holds all the decisions for one screen, such as a filter bar.

A **group** is one decision, such as "which supplier". It has a label and options.

An **option** is one thing the person can pick: a `value` (your id), a `label` (its name), and optional `aliases` (codes, short names, other languages).

```ts
{ value: "nord", label: "Nord Parts", aliases: ["nord"] }
```

## Selection

The **selection** is the answer, with one entry per group. Its shape depends on `multiple`.

With `multiple: true` (the default), a group can have many options. The text can include some and exclude others:

```ts
selection.supplier // { include: ["nord"], exclude: ["vak"] }
```

With `multiple: false`, a group has at most one option. You get the best value, the model's confidence, and every option ranked:

```ts
selection.chart // { value: "bar", confidence: 0.8, ranked: [{ value: "bar", probability: 0.8 }, { value: "line", probability: 0.1 }] }
```

`value` is `null` when no option passes the `option` threshold. Show the ranked list, or ask.

## Thresholds

The model gives each answer a probability. Two thresholds turn them into decisions:

- `option` (0.5): an option is included, excluded, or chosen only above this.
- `supported` (0.6): the options can express the text only above this. Below it, `resolve()` returns `DECISIONS_R0004`.

Raise `option` when a wrong chip costs more than a missing one. Set both with `thresholds` in [`defineChoices()`](/docs/decisions/server-api#define-choices).

## The model never invents a value

The model does not write the answer. It answers fixed questions that ViteHub builds from your groups:

- Multi-select group: each option gets "include, exclude, or none?"
- Non-empty single-select group: one question asks which option, or none.

ViteHub maps the answers back to your option values.

So the model cannot return a supplier you did not list. Unknown names add nothing. Text the options cannot express, such as "orders over 500", returns `DECISIONS_R0004` instead of a guess.

## A decision model, not a chat model

A chat model writes free text that you must parse and check. A decision model answers closed questions with probabilities. You get:

- A typed result, with no parsing or schema repair.
- A number to threshold. You decide how sure is sure enough.
- One question per multi-select option and per non-empty single-select group.

The cost: it only chooses among options. It does not compare numbers, write text, or call tools. Use an [Agent](/docs/agents) for those.

## Where code runs

The model runs only on your server, with the gateway key.

```text
browser: useChoices()  →  your route  →  resolve()  →  gateway  →  model
         (types only)      (your auth)    (server)      (key)
```

The browser sends a sentence to your route and gets a selection back. It imports only the choices type, with `import type`, so no server code reaches the bundle.

`resolve()` also works in a queue worker, a test, a script, or other server code.

## Next

- [Get started](/docs/decisions/get-started) builds a working filter box.
- [Server API](/docs/decisions/server-api) lists every option of `defineChoices()`.
- [Recipes](/docs/decisions/recipes) shows four common uses.
