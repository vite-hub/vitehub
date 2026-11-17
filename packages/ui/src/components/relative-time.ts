import { type App, computed, defineComponent, h, inject, onBeforeUnmount, onMounted, type PropType, provide, type Ref, ref, shallowRef } from "vue";
import { describeTime } from "../internal/describe-time.ts";
import { useTooltipComponent } from "../internal/nuxt-ui.ts";
import { holdSharedNow, relativeNowKey, releaseSharedNow } from "../internal/relative-now.ts";

/** A moment: milliseconds, a `Date`, or an ISO string. A date alone, such as `2026-10-12`, is a calendar day. */
export type RelativeTimeValue = number | string | Date;
/** How long the words are: `long` ("3 weeks ago"), `short` ("3 wk. ago"), or `narrow` ("3w ago"). */
export type RelativeTimeStyle = "long" | "short" | "narrow";

/**
 * Gives every `RelativeTime` below the clock that it counts from, in milliseconds. The server and the browser must
 * start from the same value, so the first render in the browser matches the HTML. The `vite-hub/ui/nuxt` module gives
 * one: the request time from the payload, then the browser clock every 30 s while the tab is visible. Call it in
 * `setup()`, or pass the `app` to call it from a plugin.
 */
export function provideRelativeNow(now: Readonly<Ref<number>>, app?: App): void {
  if (app) app.provide(relativeNowKey, now);
  else provide(relativeNowKey, now);
}

// Under a minute reads "now" both ways, so a clock that moves every 30 s and a server clock a few seconds ahead never
// show "in 3 seconds".
const NOW_WINDOW = 60_000;

/**
 * A moment as words that stay current: "5 minutes ago" while it is less than `threshold` away, then "Oct 12", or
 * "Oct 12, 2025" in another year. Its tooltip shows the full date and time in the reader's zone, or the words when the
 * label is a date. It follows comark-time's `:time`, so a page and its Markdown agree.
 */
export const RelativeTime = defineComponent({
  name: "RelativeTime",
  inheritAttrs: false,
  props: {
    // SAFETY: Vue's runtime constructors cannot express the union of the three forms.
    at: { required: true, type: [Number, String, Date] as PropType<RelativeTimeValue> },
    /** How far from now the label becomes a date, as a number and a unit (`s`, `m`, `h`, `d`, `w`, `mo`, `y`), or `none`. */
    threshold: { default: "3w", type: String },
    // SAFETY: Vue's runtime constructor cannot express this string literal union.
    style: { default: "long", type: String as PropType<RelativeTimeStyle> },
    /** A BCP 47 tag for the words and the date. */
    locale: { default: "en", type: String },
    tooltip: { default: true, type: Boolean },
  },
  setup(props, { attrs }) {
    const UTooltip = useTooltipComponent();
    const provided = inject(relativeNowKey, undefined);
    // Without a provided clock, the shared one runs once the component is in the browser.
    const fallback = shallowRef<Readonly<Ref<number>>>();
    const mounted = ref(false);
    onMounted(() => {
      if (!provided) fallback.value = holdSharedNow();
      mounted.value = true;
    });
    onBeforeUnmount(() => {
      if (fallback.value) releaseSharedNow();
    });

    const now = computed(() => provided?.value ?? fallback.value?.value);
    // The words for `now` in `timeZone`, or the runtime's zone when it is undefined.
    const describe = (timeZone?: string) => {
      const at = now.value;
      if (at === undefined) return undefined;
      const options = { locale: props.locale, style: props.style, threshold: props.threshold, timeZone };
      const time = describeTime(props.at, { ...options, now: at });
      if (!time?.datetime.includes("T")) return time;
      const instant = Date.parse(time.datetime);
      return Math.abs(instant - at) < NOW_WINDOW ? describeTime(props.at, { ...options, now: instant }) : time;
    };
    // Until it mounts, a date is the UTC one, so the server and the first render in the browser agree.
    const description = computed(() => describe(mounted.value ? undefined : "UTC"));
    // An app without a clock gets the date alone until the browser clock is known.
    const date = computed(() => {
      const time = describeTime(props.at, { locale: props.locale, now: props.at, threshold: "none", timeZone: "UTC" });
      if (!time) return undefined;
      const label = new Intl.DateTimeFormat(props.locale, { day: "numeric", month: "short", timeZone: "UTC", year: "numeric" })
        .format(Date.parse(time.datetime));
      return { ...time, label, mode: "absolute" as const };
    });
    // The tip is in the reader's zone, so it is only known in the browser.
    const tip = () => (mounted.value ? describe()?.tip : undefined);

    return () => {
      const time = description.value ?? date.value;
      if (!time) return h("time", { ...attrs, "data-slot": attrs["data-slot"] ?? "relative-time" }, String(props.at));
      const element = (title?: string) => h("time", {
        ...attrs,
        "data-mode": time.mode,
        "data-slot": attrs["data-slot"] ?? "relative-time",
        datetime: time.datetime,
        title,
      }, time.label);
      if (!props.tooltip) return element();
      // Nuxt UI renders the `content` slot only while the tooltip is open.
      if (UTooltip) return h(UTooltip, null, { content: tip, default: () => element() });
      return element(tip());
    };
  },
});
