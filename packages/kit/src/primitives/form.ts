import {
  createChange,
  definePrimitive,
  dispatch,
  type ChangeDetails,
  type ChangeOptions,
  type PrimitiveOptions,
  type SlotDefinition,
} from "@ui-sdk/core";

// Form ties the fields inside it to one submission. The browser's own
// validation still runs, and each Field shows its errors. Form adds two things:
// it hands the submitted values to `onFormSubmit`, and it shows errors your
// code passes, like a server's, on the control with the same `name` until the
// person edits it.

/** The errors a form shows, by the `name` of the control each one belongs to. */
export type FormErrors = Record<string, string | undefined>;

/** The values a form submits, by control name. A name with more than one value, like checkboxes, gets a list. */
export type FormValues = Record<string, FormDataEntryValue | FormDataEntryValue[]>;

/**
 * Why the errors changed, as `reason` in their change details: `"input-change"`
 * when the person edits a control that had an error, `"imperative"` from the api.
 */
export type FormErrorsChangeReason = "input-change" | "imperative";

/** The options `formPrimitive` takes. A component takes them as props on its root. */
export type FormOptions = {
  /**
   * Errors to show, by control name, like the ones a server returned. Each
   * control with that `name` shows the message until the person edits it, and
   * the form can't submit while one shows. Bind it with `v-model:errors`.
   */
  errors?: FormErrors;
  /** The errors it starts with, when you don't control `errors`. */
  defaultErrors?: FormErrors;
  /** Called when an error goes away, because the person edited its control. */
  onErrorsChange?: (errors: FormErrors, details: ChangeDetails<FormErrorsChangeReason>) => void;
  /**
   * Called when the form submits, after the browser's validation passes, with
   * its values by name. Without an `action` attribute, the form stays on the
   * page. With one, the browser submits it too, unless you call `details.cancel()`.
   */
  onFormSubmit?: (values: FormValues, details: ChangeDetails<"form-submit">) => void;
} & PrimitiveOptions;

/** The state the `root` slot of `formPrimitive` hands `render` functions and state-based class names. */
export type FormState = {
  /** The errors it shows now. */
  errors: FormErrors;
  /** Whether it shows at least one error. */
  invalid: boolean;
};

type FormStore = { errors: FormErrors };

/** `formPrimitive`'s api, which its slots call. Adapters expose it as `api`. */
export interface FormApi {
  /** The values the form would submit now, by control name. Undefined before the form is in the page. */
  values: () => FormValues | undefined;
  /** Replaces the errors it shows. */
  setErrors: (errors: FormErrors, details?: ChangeOptions<FormErrorsChangeReason>) => boolean;
  internal: {
    bind: (form: HTMLFormElement) => () => void;
    submit: (form: HTMLFormElement, event: SubmitEvent) => void;
    edit: (form: HTMLFormElement, event: Event) => void;
  };
}

type FormSlots = {
  root: SlotDefinition<FormStore, FormApi, { id?: string }, FormState>;
};

/** The type of `formPrimitive`. */
export interface FormPrimitive
  extends ReturnType<typeof definePrimitive<FormOptions, FormStore, FormApi, FormSlots>> {}

// A form control that takes part in constraint validation.
type Control = Element & {
  name: string;
  setCustomValidity: (message: string) => void;
  checkValidity: () => boolean;
};

const isControl = (el: Element): el is Control => "setCustomValidity" in el && "name" in el;

const controlsNamed = (form: HTMLFormElement, name: string): Control[] =>
  [...form.elements].filter((el): el is Control => isControl(el) && el.name === name);

const hasErrors = (errors: FormErrors) => Object.values(errors).some(Boolean);

// The submitter's own name and value count too, as the browser submits them.
// `FormData` throws for a submitter of another form.
const ownSubmitter = (form: HTMLFormElement, submitter?: HTMLElement | null) =>
  submitter && "form" in submitter && submitter.form === form ? submitter : undefined;

function valuesOf(form: HTMLFormElement, submitter?: HTMLElement | null): FormValues {
  const own = ownSubmitter(form, submitter);
  const data = own ? new FormData(form, own) : new FormData(form);
  const values: FormValues = {};
  for (const name of new Set(data.keys())) {
    const all = data.getAll(name);
    values[name] = all.length === 1 ? all[0]! : all;
  }
  return values;
}

/**
 * The form primitive, with the slot `root`, which renders the `<form>`.
 * Render it with an adapter's `createParts`.
 */
export const formPrimitive: FormPrimitive = definePrimitive({
  name: "form",
  options: {
    errors: "value",
    defaultErrors: "value",
    onErrorsChange: "callback",
    onFormSubmit: "callback",
  },
  controlled: ["errors"],
  state: (options: FormOptions): FormStore => ({
    errors: options.errors ?? options.defaultErrors ?? {},
  }),
  sync: (options) => (options.errors === undefined ? {} : { errors: options.errors }),
  api: (context): FormApi => {
    const { store } = context;
    const change = createChange(context);
    let form: HTMLFormElement | undefined;
    // The message each control shows now, so an error that goes away is cleared.
    let shown = new Map<Control, string>();

    // Writes each error on its controls as their custom validity. A new message
    // fires `invalid` on its control, which a Field around it reads to show it.
    function apply(el: HTMLFormElement) {
      const errors = store.get().errors;
      const next = new Map<Control, string>();
      for (const name in errors) {
        const message = errors[name];
        if (message) for (const control of controlsNamed(el, name)) next.set(control, message);
      }
      const cleared: Control[] = [];
      for (const control of shown.keys()) if (!next.has(control)) {
        control.setCustomValidity("");
        cleared.push(control);
      }
      const fresh: Control[] = [];
      for (const [control, message] of next) {
        if (shown.get(control) === message) continue;
        control.setCustomValidity(message);
        fresh.push(control);
      }
      shown = next;
      for (const control of fresh) control.checkValidity();
      // Field reads native validity on change, including a now-valid control.
      for (const control of cleared) control.dispatchEvent(new Event("change", { bubbles: true }));
    }

    return {
      values: () => (form ? valuesOf(form) : undefined),
      setErrors: (errors, details = {}) =>
        change("errors", errors, { reason: details.reason ?? "imperative", event: details.event }),
      internal: {
        bind(el) {
          form = el;
          apply(el);
          let errors = store.get().errors;
          const unsubscribe = store.subscribe(() => {
            if (store.get().errors === errors) return;
            errors = store.get().errors;
            apply(el);
          });
          return () => {
            unsubscribe();
            for (const control of shown.keys()) control.setCustomValidity("");
            shown = new Map();
            form = undefined;
          };
        },
        submit(el, event) {
          const canceled = dispatch(context, "onFormSubmit", valuesOf(el, event.submitter), {
            reason: "form-submit",
            event,
          });
          if (canceled || !el.hasAttribute("action")) event.preventDefault();
        },
        // Editing a control drops its error at once, so the Field around it reads
        // the control's own validity again, and the form can submit.
        edit(el, event) {
          const target = event.target;
          if (!(target instanceof Element) || !isControl(target)) return;
          const errors = store.get().errors;
          if (!errors[target.name]) return;
          for (const control of controlsNamed(el, target.name)) {
            control.setCustomValidity("");
            shown.delete(control);
          }
          const rest = Object.fromEntries(Object.entries(errors).filter(([name]) => name !== target.name));
          change("errors", rest, { reason: "input-change", event });
        },
      },
    };
  },
  slots: (slot) => ({
    root: slot<{}, FormState>({
      state: (state) => ({ errors: state.errors, invalid: hasErrors(state.errors) }),
      attrs: (state) => ({ "data-invalid": hasErrors(state.errors) ? "" : undefined }),
      on: {
        submit: (event, { el, api }) => api.internal.submit(el as HTMLFormElement, event as SubmitEvent),
        input: (event, { el, api }) => api.internal.edit(el as HTMLFormElement, event),
        change: (event, { el, api }) => api.internal.edit(el as HTMLFormElement, event),
      },
      bind: (el, { api }) => api.internal.bind(el as HTMLFormElement),
    }),
  }),
});
