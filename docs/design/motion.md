# Motion

Every click answers back. When a person presses, drags, or waits, the thing under the pointer reacts, and every change of state shows where it came from and where it went. Nothing teleports and nothing appears from nowhere.

Motion belongs to the interaction, not to the component. A component gets its motion from what a person does with it: press it, flip it, pick from it, drag it, wait on it. So a component we add next year moves like the ones we have today, without anyone designing its motion again.

## Rules

1. **Springs move things.** Position, size, and shape change with a spring, not with a duration and an easing curve. A spring that gets a new target keeps its speed, so a fast second click never jumps. `snappy` moves and resizes. `soft` wobbles and settles.
2. **The pressed thing gives.** On pointer down, the control squashes a little. On release, it springs back past rest and settles.
3. **Shape follows speed.** A knob, a thumb, an indicator, or a divider stretches in the direction it moves and becomes round again when it stops.
4. **Labels change letter by letter.** Keep the letters that the old and new label share. Blur out the other old letters where they are. Type the new letters in one at a time with a short blur. The control's width follows the letters. A width never jumps.
5. **Icons say what happened.** An arrow leaves in the direction it points. A spinner and a check draw their stroke in. An old icon blurs out while the new one comes in.
6. **Counts roll.** Only the digits that change roll: up when the number grows, down when it shrinks.
7. **A finished action rings once.** Saved, published, copied: a 5px ring in the border color grows around the control and fades.
8. **Things come from where they live.** A tooltip rises from behind its trigger. A toast comes in from its edge. A new list item grows from where it was made. A deleted item leaves toward where it goes. Do not fade content in from empty space.
9. **Reading surfaces open at once.** Menus, popovers, and dialogs open without motion, because the person reads them. Their trigger still reacts.
10. **Reduced motion keeps meaning, drops travel.** Under `prefers-reduced-motion`, nothing stretches, travels, or wobbles. Label and icon swaps become a 150ms crossfade. Rings and rolls are removed.
11. **Animate cheap things.** Animate `transform`, `opacity`, `filter`, and SVG path data. Animate `width` only for a label that changes, through its spring. Motion never blocks input.

## Motion follows the interaction

List what a person does with the component. Each interaction brings its effect. A component with three interactions gets three effects.

```
Press: a button, a row, a card, an icon, a menu item       → The pressed thing squashes, then springs back past rest
Toggle: a switch, a checkbox, a saved/starred/pinned icon  → The knob or icon carries the change: the knob stretches as it travels and lands larger; a check draws; a toggled icon wobbles like jelly
Select one of many: tabs, segments, radio, menu, list row  → One indicator travels to the new item, stretching toward it, then settles
Drag a value: slider, resize, scrub, reorder               → Shape follows speed: a tail trails the thumb, a divider bends past its limit and springs back
Label or icon changes with state: copy, save, deploy       → Label morph with the width following, icon swap, ring when done
A number changes                                           → Digit roll
Something appears next to its trigger: tooltip, hint       → Rises from behind its trigger, widens to fit, then slides between triggers
Something arrives on its own: toast, banner, new message   → Comes in from its edge; the others make room with a spring
Something the person reads opens: menu, popover, dialog    → Opens at once; only the trigger reacts
Items are added, removed, or reordered                     → Neighbors move to their new place with a spring; a new item grows from where it was made; a removed item folds away
Work runs: upload, deploy, sync, long request              → A head on the bar while it fills, a wave while it processes, a dot that becomes a check
Files are dragged in                                       → The drop area leans toward the dragged file
Something is deleted and the delete can be undone          → Hold to delete, the item leaves toward the trash, then Undo
```

When a component does something that is not in this list, add the interaction and its effect here before you build it.

## How a component gets its motion

1. **From the motion layer, by role.** `installMotion()` from `@vite-hub/ui/motion` attaches press, toggle, select, drag, and appear motion to elements by their role: `button`, `link`, `tab`, `radio`, `menuitem`, `option`, `switch`, `checkbox`, `slider`, `separator`, and `tooltip`. `createViteHubUI()` installs it in the browser, and the Nuxt module does it through the same plugin, so every app that uses `@vite-hub/ui` has it. Nuxt UI, kit, and our own components already render those roles, so they move with no code of their own. A new component gets the same motion when it uses the right element or role, which it must do anyway for keyboard and screen reader users.
2. **From a helper, for what only the component knows.** A label that changes, a count, progress, a list that changes, and a delete that can be undone are events of the component, not of an element. Call the helper for each: the label morph, the digit roll, the progress bar, the list mover, and hold to delete, all from `@vite-hub/ui`.

   | Event | Vue part (`@vite-hub/ui`) | Helper (`@vite-hub/ui/motion`, no Vue) |
   | --- | --- | --- |
   | Items are added, removed, or reordered | `MotionList` in place of `<TransitionGroup>`, with `origin` for a duplicate and `target` for where a removed item goes | `createMotionList(container)`: call `measure()` before the change and `play({ origin, target })` after it |
   | Work runs | `Progress` with `value` (0 to 1, or `null` for the wave) and `done` | `createProgress(host)`: `set(value)`, `done()`, `reset()` |
   | Files are dragged in | `DropField`, a label around a file input, which emits `files` | `createDropField(field, { onFiles, surface })` |
   | A delete that can be undone | `HoldToDelete` with `commit`, which emits `delete` and `undo` | `createHoldToDelete(button, { commit, onDelete, onUndo, item })` |

   `MotionList` and `Progress` take the numbers of the prototype: a new item moves out of its origin on a (380, 26) spring, a removed item folds on (260, 28), and neighbors move on `snappy`. Hold to delete runs `commit` only when the Undo window has passed. When its part unmounts or the page closes during that window, it commits: the person deleted the item and did not undo it. Use it only where the real delete can wait, such as a delete in the browser. A delete that the server must do at once keeps its confirm.
3. **Never by hand.** Do not write a local spring, a `setTimeout` letter loop, a `requestAnimationFrame` loop, or a CSS `transition`, `animation`, or `@keyframes` that imitates one of these effects. `test/design-rules.test.ts` fails on them outside the motion layer.

A surface that draws its own motion, such as a hero figure or a canvas, sets `data-motion="none"` on its root. The motion layer then skips that element and everything inside it. A plain TypeScript surface, such as the page pill, imports `installMotion` from `@vite-hub/ui/motion` (it has no Vue) and passes its shadow root, so the layer also sees the state attributes inside it.

### What the layer does

- **One listener, one observer.** `installMotion(root?)` adds one set of capture listeners on the document (`pointerdown`, `pointerup`, `pointercancel`, and `keydown`/`keyup` for Space and Enter) and one `MutationObserver` for `aria-checked`, `aria-selected`, `aria-pressed`, `aria-expanded`, `data-state`, `data-checked`, and `data-open`. The listeners read `event.composedPath()`, so they reach elements in shadow DOM. A second call adds nothing; each call returns its own uninstall.
- **One frame loop.** Every spring runs in one shared `requestAnimationFrame` loop that stops when nothing moves. A spring that gets a new target keeps its speed. `springs.snappy` (stiffness 520, damping 34) moves and resizes. `springs.soft` (380, 20) wobbles and settles.
- **Only its own properties.** The layer writes the separate CSS properties `scale`, `translate`, and `rotate`, and `filter` or `opacity` where an effect needs them, never `transform`, so it adds to a component's own transform. It removes what it wrote when the spring settles. A component must not set `scale`, `translate`, or `rotate` inline itself.
- **Press.** On pointer down, or Space or Enter on the focused control, the pressed control squashes with a stiff spring (900, 40) and springs back past rest with a loose one (380, 14) on release. It squashes by 3% from 40px high, 4% from 32px, and 5% below. An icon-only control squashes its icon by 15% and keeps its background still. Disabled controls and `aria-disabled="true"` do not squash.
- **Reduced motion.** `prefersReducedMotion()` follows the system setting live, and `forceReducedMotion()` sets it from an app setting or a test. Under it, a press does nothing and a spring jumps to its target. A helper that must still show a change passes `{ tween: 0.15 }` to `spring.to()` for the 150ms crossfade.
- **¼×.** `setMotionSlowFactor(4)` runs every spring four times slower, to record or study an effect.

### Spinners and fades

A loading spinner that turns forever (`animate-spin`, or `@keyframes` that only rotate) shows that work runs, so it is not hand-written motion. The same is true for a skeleton pulse (`animate-pulse`) and for any color or opacity fade. Rule 5 still applies when a spinner becomes a check: draw the stroke with the helper.

## Adding a component

1. List its interactions from the table above.
2. Render the right element or role for each one, so the motion layer picks it up.
3. Call the helper for each label, count, progress, list, or delete event.
4. Add it to the motion page, `packages/ui/test/browser/motion/`, and assert its effect in `test/browser/motion.browser.mjs` (`pnpm --filter @vite-hub/ui test:motion`). Record it at ¼× with `MOTION_RECORD=<dir>` and attach the recording to the pull request.

## Adding an effect

An interaction that the layer does not cover yet gets an effect of its own: a `MotionEffect` in a file in `packages/ui/src/motion/effects/`, listed in `builtInEffects`. The core does not change. An app adds one with `defineMotionEffect`, which takes the same object:

```ts
import { createSpring, defineMotionEffect, springs, writeMotionStyle } from "@vite-hub/ui/motion";

defineMotionEffect({
  name: "toggle",
  selector: "[role=switch], [aria-pressed]",
  // A pointer or key press. Return { release, move? } to hear the rest of it.
  press(element, event) {},
  // One of the state attributes changed. Also runs under reduced motion: keep the meaning.
  state(element, { attribute, oldValue, value }) {},
  // The element was added to the page, such as a tooltip.
  enter(element) {},
});
```
