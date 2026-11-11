import type { Component, InjectionKey } from "vue"

/** The views of an `account` Console that load on demand: the sign-in page, the team sidebar, and its pages. */
export interface ConsoleAccountViews {
  signIn?: Component
  shell?: Component
  team?: Component
  settings?: Component
}

/**
 * The views that the page loaded before it mounted. A view from `defineAsyncComponent` renders one task after its code
 * resolves, even when the code is already loaded, so the page would paint an empty frame. These render at once.
 */
export const consoleAccountViewsKey: InjectionKey<ConsoleAccountViews> = Symbol("vitehub-console-account-views")
