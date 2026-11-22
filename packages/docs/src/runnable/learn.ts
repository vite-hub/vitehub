/** What the Learn page shows about one tutorial page, read from its Markdown. */
export interface LearnPageFacts {
  /** The `::tutorial-step` blocks. */
  steps: number
  /** About how long the tutorial takes, in minutes. */
  minutes: number
}

/**
 * Reading at 200 words a minute, plus 2 minutes to do each step, rounded up to 5 minutes.
 * Code blocks do not count as reading, because the reader copies or opens them.
 */
export function tutorialMinutes(markdown: string): number {
  const prose = markdown.replace(/^```[\s\S]*?^```/gm, "").replace(/^---[\s\S]*?^---/m, "")
  const words = prose.split(/\s+/).filter(Boolean).length
  const steps = tutorialSteps(markdown)
  return Math.max(5, Math.ceil((words / 200 + steps * 2) / 5) * 5)
}

export function tutorialSteps(markdown: string): number {
  return markdown.match(/^::tutorial-step\b/gm)?.length ?? 0
}

/** The facts of a page with `layout: tutorial`, from its Markdown. */
export function tutorialPageFacts(markdown: string): LearnPageFacts {
  markdown = markdown.replaceAll("\r\n", "\n")
  return { steps: tutorialSteps(markdown), minutes: tutorialMinutes(markdown) }
}
