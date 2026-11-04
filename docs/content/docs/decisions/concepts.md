---
title: Decisions concepts
description: "Learn the words of Decisions: choices, groups, options, and selection. See why the model cannot invent a value and where each part runs."
navigation.title: Concepts
navigation.order: 8
navigation.group: Concepts
icon: i-lucide-lightbulb
---

Decisions turns a sentence into a choice among things you list. You list the things. ViteHub asks a model which ones the sentence means. You get a typed answer.

## The mental model

You write the options and the route. ViteHub asks the model and checks the answer. You apply the selection to your own state.

```text
your data → options → defineChoices() → resolve(text) → selection → your state
            (bridge in)                  (ViteHub)                   (bridge out)
```

Decisions has no routes, no UI, and no store. It connects to your app only through the two bridges that you write.

## Choices, groups, and options

A **choices** object is what `defineChoices()` returns. It holds all the decisions for one screen, such as one filter bar.

A **group** is one decision, such as "which supplier" or "which chart". Each group has a label and its options.

An **option** is one thing the person can pick. It has a `value` (your id), a `label` (what people call it), and optional `aliases` (codes, short names, other languages).

```ts
{ value: "nord", label: "Nord Parts", aliases: ["nord"] }
```

## Selection

The **selection** is the answer. It has one entry for each group. The shape depends on `multiple`.

A group with `multiple: true` (the default) can have many options. The text can include some and exclude others:

```ts
selection.supplier // { include: ["nord"], exclude: ["vak"] }
```

A group with `multiple: false` has at most one option. You get the best value, how sure the model is, and every option ranked:

```ts
selection.chart // { value: "bar", confidence: 0.8, ranked: [{ value: "bar", probability: 0.8 }, { value: "line", probability: 0.1 }] }
```

`value` is `null` when no option reaches the `option` threshold. Show the ranked list, or ask the person.

## Thresholds

The model gives a probability for each answer. Two thresholds turn probabilities into decisions.

- `option` (0.5): an option is included, excluded, or chosen only above this probability.
- `supported` (0.6): the options can express the text only above this probability. Below it, `resolve()` returns `DECISIONS_R0004`.

Raise `option` when a wrong chip costs more than a missing chip. Change both with `thresholds` in [`defineChoices()`](/docs/decisions/server-api#define-choices).

## The model never invents a value

The model does not write the answer. It answers fixed questions about your options: for each option, "include, exclude, or none?" ViteHub builds those questions from your groups. It maps the answers back to your option values.

So every value in the selection is one of your values. The model cannot return a supplier that you did not list. If the text names something that is not in the options, the option is not included. If the text needs something the options cannot express, such as "orders over 500", `resolve()` returns `DECISIONS_R0004` instead of a guess.

## A decision model, not a chat model

A chat model writes free text. You must parse it, check it, and handle wrong shapes. A decision model answers closed questions with probabilities. That gives you:

- A typed result. No parsing and no schema repair.
- A number you can threshold. You decide how sure is sure enough.
- One question for each option, so a bad answer for one option cannot change another.

The cost is scope. A decision model chooses among options. It does not compare numbers, write text, or call tools. Use an [Agent](/docs/agents) when you need those.

## Where code runs

The model runs on your server only. The gateway key stays there.

```text
browser: useChoices()  →  your route  →  resolve()  →  gateway  →  model
         (types only)      (your auth)    (server)      (key)
```

The browser calls your route with a sentence. It gets a selection back. It never imports the choices value. It imports only its type, with `import type`, so no server code reaches the bundle.

`resolve()` also works in a queue worker, a test, or a script. Anywhere server code runs.

## Next

- [Get started](/docs/decisions/get-started) builds a working filter box.
- [Server API](/docs/decisions/server-api) lists every option of `defineChoices()`.
- [Recipes](/docs/decisions/recipes) shows four common uses.
