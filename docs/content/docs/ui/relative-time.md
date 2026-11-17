---
title: Relative Time
description: "Show when something happened as words that stay current, such as 5 minutes ago, with the full date on hover."
navigation.order: 18
navigation.group: Parts
icon: i-lucide-clock
---

`RelativeTime` shows a moment as "5 minutes ago" while it is less than 3 weeks away. After that it shows the date, "Oct 12", or "Oct 12, 2025" in another year. Its tooltip shows the full date and time in the reader's time zone, or the words when the label is a date. The words update while the page is open.

::example{name="RelativeTimeExample" height=16}
::

## Installation

Install `@vite-hub/ui` as described in [Installation](/docs/ui/installation). The Nuxt module auto-imports `RelativeTime`. In Vue with Vite, import it from `vite-hub/ui`:

```ts
import { provideRelativeNow, RelativeTime } from "vite-hub/ui";
```

## Usage

Pass the moment as `at`: milliseconds, a `Date`, or an ISO string. Use `style="short"` in a dense list:

```vue
<template>
  <RelativeTime :at="comment.createdAt" />
  <RelativeTime at="2026-11-02T09:30:00Z" style="short" />
</template>
```

Read on 16 November 2026 at 10:30 AM in Madrid:

| Moment         | Label        | Tooltip                           |
| -------------- | ------------ | --------------------------------- |
| 40 seconds ago | now          | Mon, Nov 16, 2026, 10:29 AM GMT+1 |
| 20 days ago    | 2 weeks ago  | Tue, Oct 27, 2026, 10:30 AM GMT+1 |
| 21 days ago    | Oct 26       | 3 weeks ago · 10:30 AM GMT+1      |
| 400 days ago   | Oct 12, 2025 | last year · 11:30 AM GMT+2        |

Under a minute, before or after the clock, reads "now", so a comment that a server saved a second "in the future" does not read "in 1 second".

A date alone, such as `2026-10-12`, is a calendar day. It counts whole days, reads "today" and "yesterday", and no time zone moves it.

Pass `threshold` to change when the label becomes a date, as a number and a unit (`s`, `m`, `h`, `d`, `w`, `mo`, `y`), or `none` to keep the words. `RelativeTime` follows the same rule as comark-time's `:time`, so a page and the Markdown in it agree.

## The clock

Every `RelativeTime` counts from one clock. In Nuxt, the module gives it: the time of the request, sent in the payload, so the browser hydrates the same words that the server rendered. After the page hydrates, the clock follows the browser and moves every 30 seconds. It stops while the tab is hidden and catches up when the tab shows again.

In Vue with server rendering, give the clock yourself with `provideRelativeNow()`. Start it from the time the server rendered at, and send that time to the browser with the rest of your state:

```ts [src/relative-clock.ts]
import { type App, ref } from "vue";
import { provideRelativeNow } from "vite-hub/ui";

/** Gives the app a clock at `renderedAt`. Call the returned function after `app.mount()` in the browser. */
export function addRelativeClock(app: App, renderedAt: number): () => void {
  const now = ref(renderedAt);
  provideRelativeNow(now, app);
  return () => {
    now.value = Date.now();
    setInterval(() => (now.value = Date.now()), 30_000);
  };
}
```

Without a clock, `RelativeTime` renders the UTC date until it mounts, then counts from the browser clock. An app that renders only in the browser needs nothing.

A date label renders in UTC until the component mounts, then in the reader's time zone. The two differ only near midnight.

## Tooltip

Inside Nuxt UI's `UApp`, the tooltip is Nuxt UI's `UTooltip`. Tooltips share their open delay, so moving along a list opens the next one at once. The tooltip text is built only when it opens. Outside `UApp`, the full date is the `title` of the element. Set `tooltip` to `false` when the row around it already shows the date.

## Accessibility

The label is the text of a `<time>` element with a machine-readable `datetime`. A `<time>` cannot take focus, so a keyboard does not open the tooltip. When the time stands alone and the full date matters, add `tabindex="0"`. Leave it out inside a button or a link, such as a row of a list.

## API Reference

### RelativeTime

Renders `<time data-slot="relative-time">` with `data-mode="relative"` or `data-mode="absolute"`. Other attributes, such as `class`, pass to the `<time>`. Digits use tabular numbers, so the label keeps its width as it changes.

#### Props

| Prop        | Type                               | Default  | Description                                                                            |
| ----------- | ---------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `at`        | `number \| string \| Date`         | Required | The moment, in milliseconds, as a `Date`, or as an ISO date or instant.                |
| `threshold` | `string`                           | `"3w"`   | How far from now the label becomes a date, such as `"7d"`, or `"none"`.                |
| `style`     | `"long" \| "short" \| "narrow"`    | `"long"` | The length of the words: "3 weeks ago", "3 wk. ago", or "3w ago".                      |
| `locale`    | `string`                           | `"en"`   | A BCP 47 tag for the words and the date, such as `"es"`.                               |
| `tooltip`   | `boolean`                          | `true`   | Show the full date, or the words of a date label, in a tooltip.                        |

### provideRelativeNow

`provideRelativeNow(now: Readonly<Ref<number>>, app?: App): void`

Gives every `RelativeTime` below the clock, in milliseconds. Call it in `setup()`, or pass the `app` to call it from a plugin. The server and the browser must start from the same value.

## Related

- [Comments](/docs/ui/comments) show the time of each thread and reply with `RelativeTime`.
