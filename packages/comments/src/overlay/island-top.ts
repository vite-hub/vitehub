import { onBeforeUnmount, onMounted, ref } from "vue"

import type { Ref } from "vue"

const gap = 8

/**
 * The top of the whole-page island while the pill docks to the top edge: 8px under the pill. Else `undefined`, and the
 * island keeps its own top. `toolbar` is the overlay's element in the tool's segment of the pill.
 */
export function usePillClearance(toolbar: HTMLElement | undefined): Ref<string | undefined> {
  const top = ref<string>()
  const root = toolbar?.getRootNode()
  const segment = root instanceof ShadowRoot && root.host instanceof HTMLElement ? root.host : toolbar
  const pill = segment?.parentElement
  if (!pill) return top
  let frame = 0
  const read = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      top.value = pill.getAttribute("edge") === "top" && !pill.hidden ? `${Math.round(pill.getBoundingClientRect().bottom) + gap}px` : undefined
    })
  }
  const attributes = new MutationObserver(read)
  const size = typeof ResizeObserver === "function" ? new ResizeObserver(read) : undefined
  onMounted(() => {
    attributes.observe(pill, { attributeFilter: ["edge", "collapsed", "hidden", "style"] })
    size?.observe(pill)
    pill.addEventListener("transitionend", read)
    addEventListener("resize", read, { passive: true })
    read()
  })
  onBeforeUnmount(() => {
    attributes.disconnect()
    size?.disconnect()
    pill.removeEventListener("transitionend", read)
    removeEventListener("resize", read)
    cancelAnimationFrame(frame)
  })
  return top
}
