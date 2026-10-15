---
title: Bubble
description: "Frame message text in one of seven variants and attach reactions."
navigation.order: 11
navigation.group: Parts
icon: i-ph-chat-circle-light
---

`Bubble` frames the text of a turn. Seven variants cover the current user, the assistant, quiet notes, and errors. The parts have the same names, props, and `data-slot` attributes as the [shadcn/ui Bubble](https://ui.shadcn.com/docs/components/bubble). Colors come from the Nuxt UI tokens of your app.

::component-preview{name="BubbleExample"}
::

## Usage

```vue
<template>
  <BubbleGroup>
    <Bubble align="end">
      <BubbleContent>Run the tests again.</BubbleContent>
    </Bubble>
    <Bubble variant="ghost">
      <BubbleContent>All 42 tests pass.</BubbleContent>
    </Bubble>
  </BubbleGroup>
</template>
```

| Variant       | Use for                                       |
| ------------- | --------------------------------------------- |
| `default`     | The current user. Uses the primary color.     |
| `secondary`   | Standard conversation content.                |
| `muted`       | Quiet supporting content.                     |
| `tinted`      | A subtle primary tint.                        |
| `outline`     | Secondary or rich content with a border.      |
| `ghost`       | Unframed assistant text or rich content.      |
| `destructive` | Errors and failed actions.                    |

### Links and buttons

Set `as` on `BubbleContent` to render it as another element or component. The bubble then gets hover and focus styles:

```vue
<BubbleContent as="a" href="/runs/42">Open run 42</BubbleContent>
<BubbleContent :as="NuxtLink" to="/runs/42">Open run 42</BubbleContent>
```

### Reactions

```vue
<Bubble variant="secondary">
  <BubbleContent>Deployed to production.</BubbleContent>
  <BubbleReactions>🎉 3</BubbleReactions>
</Bubble>
```

## API reference

### Bubble

#### Props

| Prop      | Type                                                                                       | Default     | Description                         |
| --------- | ------------------------------------------------------------------------------------------ | ----------- | ----------------------------------- |
| `variant` | `"default" \| "secondary" \| "muted" \| "tinted" \| "outline" \| "ghost" \| "destructive"` | `'default'` | The visual treatment of the bubble. |
| `align`   | `"start" \| "end"`                                                                         | `'start'`   | The inline alignment of the bubble. |

### BubbleContent

| Prop | Type                  | Default | Description                                                |
| ---- | --------------------- | ------- | ---------------------------------------------------------- |
| `as` | `string \| Component` | `'div'` | Renders the content as another element, such as a link.    |

### BubbleReactions

| Prop    | Type                | Default    | Description                                    |
| ------- | ------------------- | ---------- | ---------------------------------------------- |
| `side`  | `"top" \| "bottom"` | `'bottom'` | The side of the bubble that holds the reactions. |
| `align` | `"start" \| "end"`  | `'end'`    | The inline alignment of the reactions.         |

### BubbleGroup

This part has no props.

## Accessibility

- A bubble rendered as `a` or `button` is focusable and shows a focus ring.
- Do not use color as the only signal. Say "Failed" in the text of a `destructive` bubble.
- Give reaction buttons an `aria-label`, for example "2 people reacted with thumbs up".

## Related

- [Message](/docs/ui/message) aligns the bubble in a turn.
- [Marker](/docs/ui/marker) shows status and separators between turns.
