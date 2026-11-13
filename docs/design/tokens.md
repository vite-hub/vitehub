# Tokens

All values are in `packages/ui/theme.css`. Use the semantic utility or variable. Never use the value behind it, and never use a Tailwind palette color.

## Text

```
Is it the name of the thing, a heading, or the selected item?  → text-highlighted
Is it body text?                                               → text-default (no class)
Is it a description under a name?                              → text-muted
Is it meta: a time, a count, a type, an empty value?           → text-dimmed
Is it a status (error, warning, success, info)?                → text-error / text-warning / text-success / text-info
```

Every tone keeps 4.5:1 on the page and on `bg-muted` and `bg-elevated`, so dimmed text is still readable. Do not add `opacity-*` to text to make it lighter: that drops it below 4.5:1. The status text classes use darker shades than the dots and fills, because the 500 shades are only 2.1:1 to 3.8:1 on white.

## Backgrounds

```
The page                                    → bg-default (no class)
A sidebar, a rail, a code block             → bg-muted
A hovered row, a selected item, a well      → bg-elevated
A pressed or active control                 → bg-accented
The primary button                          → handled by UButton, do not set
A menu, popover, or tooltip                 → handled by the theme: --vh-floating
```

Dark mode is its own palette: the page is `oklch(0.145 0 0)` and surfaces are white at 5% to 8% alpha. Never write `dark:` color variants; the tokens already switch.

## Borders

`border-default` for every divider and frame. `border-muted` for a divider inside a framed box. `border-accented` for the frame of a control. Borders are 1px. Do not use a border and a shadow on the same box: floating surfaces get `--vh-shadow-floating`, which includes its own hairline.

## Radius

`--ui-radius` is 0.25rem. Nuxt UI multiplies it, so these are the only radii:

| Class | Size | Use |
| --- | --- | --- |
| `rounded-md` | 6px | Buttons, inputs, tabs, badges, rows |
| `rounded-lg` | 8px | Cards, code panels, framed lists |
| `rounded-xl` | 12px | Menus, popovers, dialogs, toasts |
| `rounded-full` | | Avatars and status dots only |

A box inside a framed box uses the next smaller step, so the corners stay concentric. Never use `rounded-none`, `rounded-2xl`, or `rounded-[…]`.

## Focus

`--vh-focus` is sky 600 on light and sky 400 on dark, 3:1 on both pages. The theme uses it; components never do. Blue means focus and nothing else: links, selected items, selected text (`--vh-selection`), and primary buttons stay black and white.

```
A button, a link, a checkbox, a card link             → 2px ring, 2px outside
A menu item, an option, a tab, a table row            → 2px ring, inside the item
A link row in a framed list                           → add data-focus-inset, ring inside
A framed text field                                   → its frame turns blue and 2px (red with an error)
A field framed by a wrapper (prompt input)            → add data-focus-frame to the wrapper, it turns blue
A plain field with its own CSS border (DeviceFrame)   → add data-focus-frame to the field, it turns blue
A control whose face is a wrapper (a hidden select)   → add data-focus-ring to the wrapper, 2px ring outside
A field without a frame, the document editor          → the caret only
An element that code focused (tabindex="-1")          → no ring
```

A list that scrolls, such as a sidebar or an outline, clips a ring that sits outside. Give its rows `data-focus-inset`, or give the scroll container 4px of inline padding, so the whole ring shows.

## Media

`--vh-on-media` (white) and `--vh-media-scrim` (black at 50%) for marks over an image or a video, such as a focal point. They do not switch with the color mode, because the image does not.

## Type

Geist for text, Geist Mono for code, paths, package names, environment variables, and numbers that line up. Sizes: 12px meta, 13px dense tables, 14px UI and body, 16px reading prose and fields on touch screens. Never below 12px. Headings are `font-semibold` with `tracking-[-0.015em]` at 24px and up. Numbers that change use `tabular-nums`.

## Motion

Menus, popovers, and tooltips appear at once. Buttons scale to 97% on press. Anything else animates only `transform` and `opacity`, at 150ms to 200ms `ease-out`, and stops under `prefers-reduced-motion`.
