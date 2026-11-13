import {
  createChange,
  createRovingFocus,
  definePrimitive,
  type ChangeDetails,
  type ChangeOptions,
  type PrimitiveOptions,
  type RovingFocus,
  type SlotDefinition,
} from "@ui-sdk/core";

// Stepper shows the steps of a process and moves between them, as in Reka UI.
// Steps are numbers. The triggers have one tab stop, on the current step, and
// the arrow keys move between them. A linear stepper only goes back, or one
// step ahead.

/** Which way the steps run, which picks the arrow keys that move between them. */
export type StepperOrientation = "horizontal" | "vertical";

/** Where a step stands: done, the current one, or still to come. */
export type StepperStatus = "complete" | "current" | "upcoming";

/** Why the step changed, as `reason` in its change details. */
export type StepperValueChangeReason = "item-press" | "next-press" | "previous-press" | "imperative";

/** The options `stepperPrimitive` takes. A component takes them as props on its root. */
export type StepperOptions = {
  /** The current step. Bind it with `v-model`. */
  value?: number;
  /**
   * The step it starts on, when you don't control `value`.
   * @defaultValue 1
   */
  defaultValue?: number;
  /** Called when the current step changes. */
  onValueChange?: (value: number, details: ChangeDetails<StepperValueChangeReason>) => void;
  /**
   * Which way the steps run.
   * @defaultValue "horizontal"
   */
  orientation?: StepperOrientation;
  /**
   * Whether a person can only go back, or one step ahead.
   * @defaultValue true
   */
  linear?: boolean;
} & PrimitiveOptions;

/** The props the `item` slot of `stepperPrimitive` takes. */
export type StepperItemProps = {
  /** The step's number. */
  value: number;
  /** Whether the step can't be chosen. */
  disabled?: boolean;
  /** Shows the step as done, whatever the current step is. */
  completed?: boolean;
};

type PartProps = {
  /** @internal The step's number, from the item it sits in. */
  value?: number;
  /** @internal From the item it sits in. */
  disabled?: boolean;
  /** @internal From the item it sits in. */
  completed?: boolean;
};

/** The state the `root`, `next`, and `previous` slots of `stepperPrimitive` hand `render` functions and state-based class names. */
export type StepperState = {
  /** The current step. */
  value: number;
  orientation: StepperOrientation;
  /** Whether a step comes before the current one. */
  hasPrevious: boolean;
  /** Whether a step comes after the current one. */
  hasNext: boolean;
};

/** The state the parts inside a step hand `render` functions and state-based class names. */
export type StepperItemState = {
  /** The step's number. */
  value: number;
  /** Where the step stands. */
  status: StepperStatus;
  /** Whether the step can't be chosen now, because it's disabled or too far ahead. */
  disabled: boolean;
  orientation: StepperOrientation;
};

type StepperStore = {
  value: number;
  orientation: StepperOrientation;
  linear: boolean;
  stop: string | null;
  steps: number[];
  titles: number[];
  descriptions: number[];
};

/** `stepperPrimitive`'s api, which its slots call. Adapters expose it as `api`. */
export interface StepperApi {
  /** Goes to a step. */
  setValue: (value: number, details?: ChangeOptions<StepperValueChangeReason>) => boolean;
  /** Goes to the next step. Returns false at the last one. */
  next: (details?: ChangeOptions<StepperValueChangeReason>) => boolean;
  /** Goes to the step before. Returns false at the first one. */
  previous: (details?: ChangeOptions<StepperValueChangeReason>) => boolean;
  internal: {
    roving: RovingFocus;
    keydown: (event: KeyboardEvent, el: HTMLElement) => void;
    join: (list: "steps" | "titles" | "descriptions", value: number) => () => void;
  };
}

type Slot<Props, Public> = SlotDefinition<StepperStore, StepperApi, Props & { id?: string }, Public>;

type StepperSlots = {
  root: Slot<{}, StepperState>;
  item: Slot<StepperItemProps, StepperItemState>;
  trigger: Slot<PartProps, StepperItemState>;
  indicator: Slot<PartProps, StepperItemState>;
  title: Slot<PartProps, StepperItemState>;
  description: Slot<PartProps, StepperItemState>;
  separator: Slot<PartProps, StepperItemState>;
  next: Slot<{}, StepperState>;
  previous: Slot<{}, StepperState>;
};

/** The type of `stepperPrimitive`. */
export interface StepperPrimitive
  extends ReturnType<typeof definePrimitive<StepperOptions, StepperStore, StepperApi, StepperSlots>> {}

const fromOptions = (options: StepperOptions) => ({
  orientation: options.orientation ?? "horizontal",
  linear: options.linear ?? true,
});

// The steps around the current one, of those in the page.
const nextStep = (state: StepperStore) => state.steps.filter((step) => step > state.value).sort((a, b) => a - b)[0];
const previousStep = (state: StepperStore) =>
  state.steps.filter((step) => step < state.value).sort((a, b) => b - a)[0];

const rootState = (state: StepperStore): StepperState => ({
  value: state.value,
  orientation: state.orientation,
  hasPrevious: previousStep(state) !== undefined,
  hasNext: nextStep(state) !== undefined,
});

// A linear stepper reaches the steps before the current one, and the next.
const reachable = (state: StepperStore, props: PartProps) =>
  props.value !== undefined &&
  !props.disabled &&
  (!state.linear || props.value <= state.value || props.value === nextStep(state) || props.value === state.value + 1);

const statusOf = (state: StepperStore, props: PartProps): StepperStatus =>
  props.completed || (props.value !== undefined && props.value < state.value)
    ? "complete"
    : props.value === state.value
      ? "current"
      : "upcoming";

const itemState = (state: StepperStore, props: PartProps): StepperItemState => ({
  value: props.value ?? 0,
  status: statusOf(state, props),
  disabled: !reachable(state, props),
  orientation: state.orientation,
});

const itemAttrs = (state: StepperStore, props: PartProps) => {
  const status = statusOf(state, props);
  return {
    "data-complete": status === "complete" ? "" : undefined,
    "data-current": status === "current" ? "" : undefined,
    "data-upcoming": status === "upcoming" ? "" : undefined,
    "data-disabled": reachable(state, props) ? undefined : "",
    "data-orientation": state.orientation,
  };
};

const partId = (id: string, part: string, value: number | undefined) => `${id}-${part}-${value ?? ""}`;

const itemProps = {
  value: { kind: "number", from: "item", required: true },
  disabled: { kind: "boolean", from: "item.disabled" },
  completed: { kind: "boolean", from: "item.completed" },
} as const;

/**
 * The stepper primitive, with the slots `root`, `item`, `trigger`,
 * `indicator`, `title`, `description`, `separator`, `next`, `previous`.
 * Render it with an adapter's `createParts`.
 */
export const stepperPrimitive: StepperPrimitive = definePrimitive({
  name: "stepper",
  options: {
    value: "number",
    defaultValue: "number",
    onValueChange: "callback",
    orientation: "string",
    linear: "boolean",
  },
  controlled: ["value"],
  state: (options: StepperOptions): StepperStore => ({
    value: options.value ?? options.defaultValue ?? 1,
    stop: null,
    steps: [],
    titles: [],
    descriptions: [],
    ...fromOptions(options),
  }),
  sync: (options) => ({
    ...fromOptions(options),
    ...(options.value === undefined ? {} : { value: options.value }),
  }),
  api: (context): StepperApi => {
    const { store } = context;
    const change = createChange(context);
    const roving = createRovingFocus<StepperStore, PartProps>(context, {
      slot: "trigger",
      key: "stop",
      orientation: () => store.get().orientation,
      remember: false,
      focusable: (item) => reachable(store.get(), item.props),
      preferred: (item) => item.props?.value === store.get().value,
      claims: (state, item) => item.props?.value === state.value,
    });
    const go = (value: number | undefined, details: ChangeOptions<StepperValueChangeReason>) =>
      value !== undefined && change("value", value, { reason: details.reason ?? "imperative", event: details.event });

    return {
      setValue: (value, details = {}) => go(value, details),
      next: (details = {}) => go(nextStep(store.get()), details),
      previous: (details = {}) => go(previousStep(store.get()), details),
      internal: {
        roving,
        keydown(event, el) {
          if (!event.defaultPrevented) roving.keydown(event, el);
        },
        join(list, value) {
          store.set({ [list]: [...store.get()[list], value] });
          return () => {
            const values = [...store.get()[list]];
            values.splice(values.indexOf(value), 1);
            store.set({ [list]: values });
          };
        },
      },
    };
  },
  slots: (slot) => ({
    root: slot<{}, StepperState>({
      role: "group",
      state: rootState,
      attrs: (state) => ({
        "data-orientation": state.orientation,
        "data-linear": state.linear ? "" : undefined,
      }),
    }),
    item: slot<StepperItemProps, StepperItemState>({
      props: { value: "number", disabled: "boolean", completed: "boolean" },
      state: (state, { props }) => itemState(state, props),
      attrs: (state, { props }) => itemAttrs(state, props),
      bind: (_el, { api, props }) => api.internal.join("steps", props.value),
    }),
    trigger: slot<PartProps, StepperItemState>({
      props: itemProps,
      state: (state, { props }) => itemState(state, props),
      attrs: (state, { id, key, props, api }) => ({
        type: "button",
        tabindex: api.internal.roving.tabIndex(state, { key, props }),
        disabled: reachable(state, props) ? undefined : "",
        "aria-current": statusOf(state, props) === "current" ? "step" : undefined,
        "aria-labelledby":
          props.value !== undefined && state.titles.includes(props.value) ? partId(id, "title", props.value) : undefined,
        "aria-describedby":
          props.value !== undefined && state.descriptions.includes(props.value)
            ? partId(id, "description", props.value)
            : undefined,
        ...itemAttrs(state, props),
      }),
      press: ({ api, props }, event) => {
        if (props.value !== undefined) api.setValue(props.value, { reason: "item-press", event });
      },
      on: { keydown: (event, { el, api }) => el && api.internal.keydown(event as KeyboardEvent, el) },
      bind: (el, part) => part.api.internal.roving.bind(el, part),
    }),
    indicator: slot<PartProps, StepperItemState>({
      props: itemProps,
      state: (state, { props }) => itemState(state, props),
      attrs: (state, { props }) => itemAttrs(state, props),
    }),
    title: slot<PartProps, StepperItemState>({
      props: itemProps,
      state: (state, { props }) => itemState(state, props),
      attrs: (state, { id, props }) => ({ id: partId(id, "title", props.value), ...itemAttrs(state, props) }),
      bind: (_el, { api, props }) => (props.value === undefined ? undefined : api.internal.join("titles", props.value)),
    }),
    description: slot<PartProps, StepperItemState>({
      props: itemProps,
      state: (state, { props }) => itemState(state, props),
      attrs: (state, { id, props }) => ({ id: partId(id, "description", props.value), ...itemAttrs(state, props) }),
      bind: (_el, { api, props }) =>
        props.value === undefined ? undefined : api.internal.join("descriptions", props.value),
    }),
    separator: slot<PartProps, StepperItemState>({
      props: itemProps,
      state: (state, { props }) => itemState(state, props),
      attrs: (state, { props }) => ({ "aria-hidden": "true", ...itemAttrs(state, props) }),
    }),
    next: slot<{}, StepperState>({
      state: rootState,
      attrs: (state) => ({
        type: "button",
        disabled: nextStep(state) === undefined ? "" : undefined,
        "data-orientation": state.orientation,
      }),
      press: ({ api }, event) => api.next({ reason: "next-press", event }),
    }),
    previous: slot<{}, StepperState>({
      state: rootState,
      attrs: (state) => ({
        type: "button",
        disabled: previousStep(state) === undefined ? "" : undefined,
        "data-orientation": state.orientation,
      }),
      press: ({ api }, event) => api.previous({ reason: "previous-press", event }),
    }),
  }),
});
