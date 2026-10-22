import { shallowRef } from "vue"

import type { ShallowRef } from "vue"

/**
 * Console toasts. They live in their own list, not in Nuxt UI `useToast()`: that list is shared with the host app, so a
 * Console mounted in a Nuxt app would show its toasts in the host toaster, or nowhere when the host turns toasts off.
 * `ConsoleToaster` renders this list inside the Console only.
 */
export interface ConsoleToastAction {
  label: string
  onClick: () => void | Promise<void>
}

export interface ConsoleToast {
  action?: ConsoleToastAction
  /** Milliseconds before the toast closes. Undo toasts stay longer. */
  duration: number
  /** Error toasts use the error color for the icon only. */
  error?: boolean
  id: number
  title: string
}

export interface ConsoleToastInput {
  action?: ConsoleToastAction
  duration?: number
  title: string
}

/** Default toast duration, and the longer one for a toast with an Undo action (Geist: 5–10 seconds). */
export const consoleToastDuration = 4_000
export const consoleUndoToastDuration = 8_000
const maxToasts = 3

const toasts = shallowRef<readonly ConsoleToast[]>([])
let nextId = 0

function add(input: ConsoleToastInput, error = false): ConsoleToast {
  const toast: ConsoleToast = {
    duration: input.duration ?? (input.action ? consoleUndoToastDuration : consoleToastDuration),
    id: ++nextId,
    title: input.title,
  }
  if (input.action) toast.action = input.action
  if (error) toast.error = true
  toasts.value = [...toasts.value, toast].slice(-maxToasts)
  return toast
}

function remove(id: number): void {
  toasts.value = toasts.value.filter(toast => toast.id !== id)
}

export interface ConsoleToasts {
  /** Shows an error toast, such as `Couldn't publish. Try again.` */
  error: (title: string, action?: ConsoleToastAction) => ConsoleToast
  remove: (id: number) => void
  /** Shows a confirmation, such as `Changes published`, optionally with an Undo action. */
  show: (input: ConsoleToastInput) => ConsoleToast
  toasts: Readonly<ShallowRef<readonly ConsoleToast[]>>
}

/** Shows Console toasts: one sentence, `{Noun} {past participle}` for success, `Couldn't … Try again.` for errors. */
export function useConsoleToast(): ConsoleToasts {
  return {
    error: (title: string, action?: ConsoleToastAction) => add(action ? { action, title } : { title }, true),
    remove,
    show: (input: ConsoleToastInput) => add(input),
    toasts,
  }
}
