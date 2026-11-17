# Motion

Every click answers back. When a person presses, drags, or waits, the thing under the pointer reacts, and every change of state shows where it came from and where it went. Nothing teleports and nothing appears from nowhere.

We do not collect effects. We use the few effects on this page, the same way, in every surface: the Console, vitehub.dev, `@vite-hub/docs` sites, and the playgrounds. When a component needs motion that is not here, add it here first.

## Rules

1. **Springs move things.** Position, size, and shape changes use a spring, not a duration and an easing curve. A spring that gets a new target keeps its speed, so a fast second click never jumps. Use `snappy` (stiffness 480, damping 36) for position and width, and `soft` (stiffness 320, damping 16) for a wobble that settles.
2. **The pressed thing gives.** On pointer down, the control squashes a little. On release it springs back past rest and settles. Buttons scale to 96%. A knob or an icon squashes more than the button around it.
3. **Shape follows speed.** A knob, a thumb, or a divider stretches in the direction it moves and becomes round again when it stops. The faster it moves, the more it stretches.
4. **Labels change letter by letter.** Keep the letters the old and new label share. Blur out the other old letters where they are. Type the new letters in one at a time with a short blur. The control's width follows the letters with a spring. A width never jumps.
5. **Icons say what happened.** An arrow leaves in the direction it points. A spinner and a check draw their stroke in. An old icon blurs out while the new one comes in.
6. **Counts roll.** Only the digits that change roll: up when the number grows, down when it shrinks. Digits that do not change stay still.
7. **A finished action rings once.** Saved, published, or copied: a 5px ring in the border color grows around the control and fades.
8. **Things come from where they live.** A tooltip rises from behind its toolbar. A copy slides out from behind the button that made it. Deleted letters drop into the trash icon. Do not fade in content from empty space.
9. **Reading surfaces open at once.** Menus, popovers, and dialogs open without motion, because the person reads them. A tooltip waits 150ms the first time, rises from behind its trigger, widens to fit its label, and then slides between triggers without waiting again.
10. **Reduced motion keeps meaning, drops travel.** Under `prefers-reduced-motion`, nothing stretches, travels, or wobbles. Label and icon swaps become a 150ms crossfade. Rings and rolls are removed.
11. **Animate cheap things.** Animate `transform`, `opacity`, `filter`, and SVG path data. Animate `width` only on the control whose label changes, through its spring. Motion never blocks input.

## Effects and where they go

```
A control is pressed                                     → Press: squash, spring back past rest
A button's label changes (Copy → Copied, Deploy → Deploying)
                                                         → Label morph, width follows
An action starts, then finishes                          → Icon swap: arrow out, spinner draws, check draws, ring
A toggle saves something (bookmark, star, pin)           → Jelly icon: the icon body wobbles top to bottom
A number changes (comments, runs, unread)                → Digit roll
A switch flips                                           → Gummy knob: small and grey when off, larger and solid when on, wobbles when it lands
A tab or a segment changes                               → The underline stretches toward the new tab, then settles
A toolbar icon shows its label                           → Tooltip from behind the bar
An action makes a copy (duplicate)                       → Copies slide out up and to the left, collapse when idle
An item can be deleted and the delete can be undone      → Hold to delete, then Undo
A value is dragged                                       → Round thumb with a tail that trails behind it, value bubble with rolling digits
Something uploads or processes                           → Progress head while it fills, a wave while it processes, a dot that turns into a check
Files can be dropped                                     → Dot field that leans toward the dragged file
A panel can be resized or folded                         → The divider bends past its limit; a hard pull folds the panel
```

## Where each effect goes

| Effect | ViteHub components |
| --- | --- |
| Press | `UButton` (theme), `CopyButton`, toolbar icon buttons, `console-page-toolbar` |
| Label morph | `CopyButton` with a label, the docs "Copy page" button, Console buttons that start a long action |
| Icon swap | `CopyButton` (`copy` → `copyCheck`), loading buttons |
| Jelly icon | Comment pin, resolve, and any icon toggle that saves state |
| Digit roll | Console counts, `AvatarStack` overflow count, `SyncStatus` |
| Gummy knob | `USwitch` (theme) |
| Tab underline | `UTabs` (theme), the docs framework tabs |
| Tooltip from behind | `UTooltip` on toolbars, code block actions in `CodeBlock` |
| Duplicate stack | Duplicate actions in the Console |
| Hold to delete | Console and Comments delete actions that can be undone |
| Slider | `USlider` (theme) |
| Progress | Blob uploads, deploy progress, `Attachment` uploads |
| Dot field | `CommentComposer` attachments, Blob uploads |
| Elastic divider | Console inspector and sidebar, playground split |

A component that is in this table and does not move as this page says is a bug.

## One implementation

Put the springs, the label morph, the digit roll, and the jelly path in `@vite-hub/ui`, and use them from there, so every surface feels the same. Do not write a local spring, a local `setTimeout` letter loop, or a CSS `transition` that imitates one of these effects.
