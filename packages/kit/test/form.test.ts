// @vitest-environment happy-dom
import { h, ref, type Ref } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import { Field, FieldControl, FieldError, FieldLabel } from "@vite-hub/kit/field";
import { Form, type FormErrors, type FormValues } from "@vite-hub/kit/form";

import { mount, one, settle, type } from "./dom.ts";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

type Submit = { values: FormValues; prevented: boolean };

function render(errors: Ref<FormErrors>, props: Record<string, unknown> = {}) {
  const submits: Submit[] = [];
  const view = mount(() =>
    h(
      Form,
      {
        errors: errors.value,
        "onUpdate:errors": (next: FormErrors) => (errors.value = next),
        onFormSubmit: (values: FormValues, details: { event?: Event }) =>
          // The form's own listener decides after this one, so read it a task later.
          setTimeout(() => submits.push({ values, prevented: !!details.event?.defaultPrevented })),
        ...props,
      },
      () => [
        h(Field, { name: "email" }, () => [
          h(FieldLabel, null, () => "Email"),
          h(FieldControl, { type: "email", required: true }),
          h(FieldError),
        ]),
        h("input", { type: "checkbox", name: "topics", value: "vue", checked: true }),
        h("input", { type: "checkbox", name: "topics", value: "nuxt", checked: true }),
        h("button", { type: "submit" }, "Send"),
      ],
    ),
  );
  cleanup = view.unmount;
  const form = one<HTMLFormElement>(view.host, "form");
  const email = one<HTMLInputElement>(view.host, 'input[name="email"]');
  const error = () => view.host.querySelector('[data-slot="field-error"]')?.textContent ?? null;
  const submit = async () => {
    form.requestSubmit();
    await settle();
  };
  return { ...view, form, email, error, submit, submits };
}

describe("Form", () => {
  it("renders a form and hands the submitted values to @form-submit, without leaving the page", async () => {
    const { form, email, submit, submits } = render(ref({}));
    expect(form.getAttribute("data-slot")).toBe("form");
    await type(email, "ada@example.com");
    await submit();
    expect(submits).toEqual([{ values: { email: "ada@example.com", topics: ["vue", "nuxt"] }, prevented: true }]);
  });

  it("lets the browser submit to an action, unless the handler cancels", async () => {
    const { email, form, submits } = render(ref({}), { action: "/subscribe" });
    await type(email, "ada@example.com");
    const event = new SubmitEvent("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    await settle();
    expect(submits).toHaveLength(1);
  });

  it("shows errors from your code in the Field of the control with the same name", async () => {
    const errors = ref<FormErrors>({});
    const { email, error, form } = render(errors);
    await type(email, "ada@example.com");
    expect(error()).toBeNull();

    errors.value = { email: "This email is taken." };
    await settle();
    expect(error()).toBe("This email is taken.");
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(form.hasAttribute("data-invalid")).toBe(true);
    expect(email.validity.valid).toBe(false);
  });

  it("refreshes Field when errors are cleared programmatically", async () => {
    const errors = ref<FormErrors>({});
    const { email, error } = render(errors);
    await type(email, "ada@example.com");
    errors.value = { email: "Taken" };
    await settle();
    expect(error()).toBe("Taken");
    errors.value = {};
    await settle();
    expect(email.validity.valid).toBe(true);
    expect(email.getAttribute("aria-invalid")).not.toBe("true");
    expect(error()).toBeNull();
  });

  it("drops an error when the person edits its control", async () => {
    const errors = ref<FormErrors>({ email: "This email is taken.", other: "Kept." });
    const { email, error, submit, submits } = render(errors);
    await settle();
    expect(error()).toBe("This email is taken.");

    await type(email, "ada@example.com");
    expect(errors.value).toEqual({ other: "Kept." });
    expect(error()).toBeNull();
    expect(email.validity.valid).toBe(true);
    await submit();
    expect(submits).toHaveLength(1);
  });

  it("keeps the browser's validation, so an invalid form doesn't submit", async () => {
    const { submit, submits, error } = render(ref({}));
    await submit();
    expect(submits).toEqual([]);
    expect(error()).not.toBeNull();
  });
});
