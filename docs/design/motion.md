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

1. **From the motion layer, by role.** `@vite-hub/ui` attaches press, toggle, select, drag, and appear motion to elements by their role: `button`, `link`, `tab`, `radio`, `menuitem`, `option`, `switch`, `checkbox`, `slider`, `separator`, and `tooltip`. Nuxt UI, kit, and our own components already render those roles, so they move with no code of their own. A new component gets the same motion when it uses the right element or role, which it must do anyway for keyboard and screen reader users.
2. **From a helper, for what only the component knows.** A label that changes, a count, progress, a list that changes, and a delete that can be undone are events of the component, not of an element. Call the helper for each: the label morph, the digit roll, the progress bar, the list mover, and hold to delete, all from `@vite-hub/ui`.
3. **Never by hand.** Do not write a local spring, a `setTimeout` letter loop, a `requestAnimationFrame` loop, or a CSS `transition`, `animation`, or `@keyframes` that imitates one of these effects. `test/design-rules.test.ts` fails on them outside the motion layer.

A surface that draws its own motion, such as a hero figure or a canvas, sets `data-motion="none"` on its root. The motion layer then skips that element and everything inside it.

## Adding a component

1. List its interactions from the table above.
2. Render the right element or role for each one, so the motion layer picks it up.
3. Call the helper for each label, count, progress, list, or delete event.
4. Add it to the motion page of the UI playground, and attach a short ¼× recording to the pull request.
