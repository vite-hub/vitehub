/** Synthetic bundled files for the real Console Skills browser. */
export const playgroundSkillFiles: Record<string, string> = {
  ".agents/skills/interface-design/SKILL.md": `---
name: interface-design
description: Build clear, compact interfaces that fit the existing product.
---
# Interface design

Build interfaces that make the next action clear. Use the product's existing components, spacing, and color tokens.

## When to use

Use this skill when building a screen, improving a layout, or reviewing an interface before it ships.

## Workflow

1. Read the existing screen and its components.
2. Identify the main task and the information it needs.
3. Build the smallest complete interaction.
4. Check the result at wide and narrow widths.

## File map

- [references/layout.md](references/layout.md) sets spacing and panel rules.
- [references/accessibility.md](references/accessibility.md) covers keyboard access and focus.
- [scripts/check-contrast.ts](scripts/check-contrast.ts) checks a text and background pair.

> [!NOTE]
> Supporting files are part of the Skill. Open the links above to read them in this browser.

## Before you finish

Check loading, empty, and error states. Every icon button needs an accessible name. Keep file paths and code selectable.
`,
  ".agents/skills/interface-design/references/layout.md": "# Layout\n\nKeep the file tree beside the preview on wide screens. Stack the tree above the preview on narrow screens.\n\nUse one scroll area per pane. Long file names must not widen the page.\n",
  ".agents/skills/interface-design/references/accessibility.md": "# Accessibility\n\nEvery control needs an accessible name and visible keyboard focus.\n\nUse arrow keys to navigate the file tree and Enter to open a file.\n",
  ".agents/skills/interface-design/scripts/check-contrast.ts": "export function contrastRatio(light: number, dark: number): number {\n  return (light + 0.05) / (dark + 0.05);\n}\n",
  ".agents/skills/code-review/SKILL.md": "---\nname: code-review\ndescription: Review changes against their intended behavior.\n---\n# Code review\n\nRead the diff and trace each changed behavior to its callers. Report findings with a location, evidence, and a concrete fix.\n\n## Check the result\n\nRun the smallest check that proves the changed behavior. Read references/review-checklist.md before reporting findings.\n",
  ".agents/skills/code-review/references/review-checklist.md": "# Review checklist\n\n- Check the public contract.\n- Trace changed callers.\n- Verify errors and interrupted requests.\n- Separate observed failures from untested concerns.\n",
  ".agents/skills/writing/SKILL.md": "---\nname: writing\ndescription: Write short, plain English.\n---\n# Writing\n\nStart with the result. Use familiar words and concrete examples. Delete sentences that do not help the reader decide or act.\n",
};
