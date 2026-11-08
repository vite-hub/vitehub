# Components

Nuxt UI components, styled by `vitehubTheme`. The theme sets the defaults below, so most call sites pass no `variant`, `size`, or `color`. An unlisted variant is a bug, not an option.

## Button

`UButton` for every action. A link that only navigates is `ULink`, or `UButton` with `to` when it must look like a button.

- No `color` and no `variant`: black on light, white on dark. The single most important action on a view. One per view.
- `variant="outline"`: the second action beside a primary one, such as Cancel.
- `variant="ghost"`: toolbar, row, and icon-only actions. This is the most common button.
- `color="error"`: destructive actions only, inside the confirmation, not on the button that opens it.

Size `sm` is the default. Use `xs` in dense rows and `md` only in a form's submit row.

```vue
<!-- Correct -->
<UButton icon="i-lucide-copy" variant="ghost" aria-label="Copy the command" @click="copy" />

<!-- Incorrect: a hand-styled button, with its own focus ring -->
<button class="rounded px-2 hover:bg-zinc-100 focus-visible:ring-2" @click="copy">Copy</button>
```

## Tabs

`UTabs` for every set of views that share one place, from the Console to a code group in the docs. The theme makes them underline tabs: the label is `text-muted`, the active label `text-highlighted` with a 1px line under it, and the line slides. Do not pass `variant="pill"`; a segmented pill is not part of the system.

```
Switch between views of the same thing (Terminal / Agent prompt)?  → UTabs
Pick one value for a form (a host, a region)?                      → URadioGroup
Turn one thing on or off?                                          → USwitch
Filter a list (All / Errors / Warnings)?                           → UTabs with :content="false"
```

```vue
<!-- Correct -->
<UTabs v-model="mode" :items="modeItems" :content="false" />

<!-- Incorrect: a hand-made tab strip -->
<div role="tablist"><button role="tab" :aria-selected="mode === 'command'">Terminal</button></div>
```

## Badge

`UBadge` for a short label beside a name: a status, a count, a version. Default is `variant="subtle"`, `color="neutral"`. Use a status `color` (`success`, `warning`, `error`, `info`) only when the badge is a status. Never use a badge for a button or a link.

## Text fields

`UInput`, `UTextarea`, `USelect`, `USelectMenu`, `UInputMenu`. Wrap them in `UFormField` for the label, the hint, and the error. On focus the frame turns blue; never add a ring. Fields are 16px on touch screens, so iOS does not zoom.

## Checkbox and radio

`UCheckbox` and `URadioGroup`. `variant="card"` with `indicator="end"` for a choice that needs a description, such as a host or a feature. The focused box gets the ring; the card does not get a second one.

## Card and list

`UCard` for a framed group of related content with a header or footer. `UPageCard` for a link to another page with an icon, a title, and a description. A list of rows is not a set of cards: use a `divide-y divide-default` list with `hover:bg-elevated` rows.

## Empty state

`UEmpty` for every empty list, panel, or search result: a title that names what is missing, one line on how to add it, and the action. Size it like the filled state, so adding the first item moves nothing.

## Floating surfaces

`UDropdownMenu` for actions, `UPopover` for content, `UTooltip` for a label of an icon-only control, `UModal` for a task that blocks the page. The theme gives them the 12px radius, the floating surface, and the layered shadow. Menus and tooltips do not animate.

## Keyboard keys

`UKbd` for every shortcut. Size `sm` beside 12px text, `md` beside 14px text.
