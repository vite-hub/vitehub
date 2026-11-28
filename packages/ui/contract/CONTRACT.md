# The ViteHub UI props contract

Every component of `@vite-hub/ui` and every item of the `@vitehub` registry follows these rules. Read them before you build or change a component. `test/contract.test.ts` checks the rules marked **(test)** against `api.json`. The other rules are for review.

After you change a component, run `pnpm run contract:api` in `packages/ui` and commit `api.json`. When the change removes or renames a prop, an event, a slot, or a component, add a row to `migrations.ts`. When it fixes a listed violation, remove that row from `violations.json`. The test fails until you do.

## 1. Structure: compound parts

A component is a root and its parts. A root with no children renders the default composition, so the short form always works. A prop that changes only one child becomes that child's part or slot.

```vue
<!-- Good -->
<PromptInput v-model="text" @submit="send" />
<PromptInput v-model="text" @submit="send">
  <PromptInputTextarea />
  <PromptInputToolbar><PromptInputSubmit /></PromptInputToolbar>
</PromptInput>

<!-- Bad: a root prop that styles one child -->
<PromptInput v-model="text" attach-variant="ghost" />
```

## 2. Props

- Declare props with `defineProps<T>()` and an exported type.
- **(test)** A boolean is positive and defaults to `false`. Do not name a boolean `no*`, `hide*`, or `disable*`.
- **(test)** Shared look props take only these values:
  - `variant`: `solid`, `outline`, `soft`, `ghost`, `link`, `destructive`
  - `size`: `xs`, `sm`, `md`, `lg`
  - `tone`: `neutral`, `success`, `warning`, `error`, `info`
- Domain state keeps its domain name and values, such as `status: "streaming"`. Do not call it `variant` or `tone`.

```ts
// Good
defineProps<{ tone?: "neutral" | "success"; pulse?: boolean; attachments?: boolean }>()
// Bad: a boolean that is true by default, a negative name, a value outside the vocabulary
defineProps<{ attachments?: boolean /* default true */; hideLabel?: boolean; variant?: "subtle" }>()
```

To turn off a part that shows by default, let the developer leave the part out of the composition (rule 1), or give the prop a positive name with a `false` default, such as `bare`.

## 3. Banned props

**(test)** These props are not allowed:

| Prop | Use instead |
| --- | --- |
| `ui` | `class` on the part |
| `*Class`, such as `contentClass` | `class` on the part |
| `color` | `tone` |
| An icon name string, such as `icon="i-lucide-copy"` | The icon slot |
| `as` | ui-sdk's `#render` slot |

```vue
<!-- Good -->
<CopyButton :value="url"><template #icon><Link2 /></template></CopyButton>
<MarkerContent class="text-sm" />
<!-- Bad -->
<CopyButton :value="url" icon="i-lucide-link-2" />
<Marker content-class="text-sm" as="li" />
```

## 4. State: v-model

- The main value is `v-model` (`modelValue`, `update:modelValue`). Other values are `v-model:<key>`.
- **(test)** Every `update:x` event has a prop `x`.
- **(test)** Every model has a `default<Key>` prop for an uncontrolled start: `defaultValue` for `v-model`, `defaultOpen` for `v-model:open`.

```ts
// Good
defineProps<{ open?: boolean; defaultOpen?: boolean }>()
defineEmits<{ "update:open": [open: boolean] }>()
// Bad: an update event with no prop, and no uncontrolled start
defineEmits<{ "update:sidebar": [open: boolean] }>()
```

## 5. Events

Events are bare verbs with one payload object: `submit`, `stop`, `retry`, `select`. An event does not repeat a v-model. A function prop is allowed only when the component needs its return value, such as `filterFiles`.

```ts
// Good
defineEmits<{ submit: [event: { text: string; files: File[] }] }>()
// Bad: positional arguments, a noun, an event that repeats `update:modelValue`
defineEmits<{ uploadError: [error: unknown, file: File]; change: [value: string] }>()
```

## 6. DOM

- `class` and other attributes fall through to the root.
- **(test)** The root renders `data-slot="<item>"`, the kebab-case name of the component: `CopyButton` renders `data-slot="copy-button"`. A part renders `<item>-<part>`: `copy-button-icon`.
- An enum prop reflects as `data-<prop>="<value>"`. A boolean reflects as a presence attribute, such as `data-open`.
- **(test)** Never render `data-state`. Use `data-<prop>` or a presence attribute.

```ts
// Good
h("span", { "data-slot": "status", "data-tone": props.tone, "data-pulse": props.pulse ? "" : undefined })
// Bad: a class instead of a data-slot, and data-state
h("span", { class: "vh-status", "data-state": props.open ? "open" : "closed" })
```

## 7. Text and icons

- Built-in text is a `label` prop with an English default. A part with more than one text has `<what>Label` props, such as `copiedLabel`.
- An icon is a slot. Its default is a `@lucide/vue` component imported in the file.

```vue
<!-- Good -->
<HoldToDelete label="Hold to remove" @delete="remove"><template #icon><Trash2 /></template></HoldToDelete>
<!-- Bad: the text is fixed in the file, the icon is a string -->
<HoldToDelete icon="i-lucide-trash-2" @delete="remove" />
```

## 8. Types

**(test)** Export `<Name>Props` for every component, `<Name>Emits` when it has events, and `<Name>Slots` when it has slots. Do not use `any`.

```ts
// Good
export interface StatusProps { tone?: StatusTone; label?: string }
export interface StatusSlots { default?: () => VNodeChild }
// Bad: the props are only in the runtime options
export const Status = defineComponent({ props: { tone: String } })
```

## 9. Styles

The styles are in `@layer components`. A selector names only the item's own `data-slot` values. A value comes from a token, such as `var(--muted-foreground)`, never a literal color.

```css
/* Good */
@layer components {
  [data-slot="status-indicator"] { background: var(--status-color, var(--muted-foreground)); }
}
/* Bad: another item's slot, a literal color, no layer */
[data-slot="badge"] [data-slot="status-indicator"] { background: #16a34a; }
```

## Files

- `api.json`: the generated report of every exported component name and entry. `rootDataSlots` records root values; `dataSlots` also includes parts. `*` in a slot name marks a dynamic name or a slot supplied by a replaceable child. `pnpm run contract:api` writes the report from `report.ts`. Build first: the report reads types from the built `.d.ts` of workspace dependencies.
- `violations.json`: the current violations of the rules in `rules.ts`. `pnpm run contract:api -- --violations` refreshes it. Tests reject stale rows and additions compared to the merge base once it has a baseline.
- `audit.md`: today's API and the target API of each component family.
- `migrations.ts`: the rename table for the `vitehub migrate` codemod and the migration page. `component`, `from`, and `fromKind` identify the old surface; `to` and `kind` describe its replacement. Use `fromKind: "entry"` and the old entry key (for example `"./headless"`) when the name still exists on another entry. Use `fromKind: "component"` and the old name when it disappears from every entry. `to` is `null` when there is no replacement. `note` explains the change, including value changes and opposite booleans.
