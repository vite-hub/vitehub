import { createSSRApp, h, type VNode } from "vue";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";

import { AspectRatio } from "@vite-hub/kit/aspect-ratio";
import {
  Editable,
  EditableArea,
  EditableCancelTrigger,
  EditableEditTrigger,
  EditableInput,
  EditablePreview,
  EditableSubmitTrigger,
} from "@vite-hub/kit/editable";
import { Field, FieldControl, FieldError } from "@vite-hub/kit/field";
import { Form } from "@vite-hub/kit/form";
import {
  Stepper,
  StepperDescription,
  StepperIndicator,
  StepperItem,
  StepperNext,
  StepperPrevious,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from "@vite-hub/kit/stepper";
import { TagGroup, TagGroupItem, TagGroupItemRemove } from "@vite-hub/kit/tag-group";
import {
  TagsInput,
  TagsInputClear,
  TagsInputInput,
  TagsInputItem,
  TagsInputItemDelete,
  TagsInputItemText,
} from "@vite-hub/kit/tags-input";
import { VisuallyHidden } from "@vite-hub/kit/visually-hidden";

const render = (tree: () => VNode) => renderToString(createSSRApp({ render: tree }));

// The server's HTML for the components the kit adds, before any script runs.
describe("server rendering of the kit's own components", () => {
  it("renders Form as a form, with the errors it starts with", async () => {
    const html = await render(() =>
      h(Form, { errors: { email: "Taken." } }, () =>
        h(Field, { name: "email" }, () => [h(FieldControl), h(FieldError)]),
      ),
    );
    expect(html).toMatch(/^<form data-slot="form" data-invalid>/);
    expect(html).toContain('data-slot="field-control"');
  });

  it("renders Editable with its preview, and the input only while editing", async () => {
    const html = await render(() =>
      h(Editable, { defaultValue: "Draft", name: "title" }, () => [
        h(EditableArea, null, () => [h(EditablePreview), h(EditableInput)]),
        h(EditableEditTrigger, null, () => "Edit"),
        h(EditableSubmitTrigger, null, () => "Save"),
        h(EditableCancelTrigger, null, () => "Cancel"),
      ]),
    );
    expect(html).toContain('<div data-slot="editable">');
    expect(html).toContain('<span data-slot="editable-preview" tabindex="0">Draft</span>');
    expect(html).toContain('<button data-slot="editable-edit-trigger" type="button">Edit</button>');
    expect(html).toContain('<input data-slot="editable-hidden-input" type="hidden" name="title" value="Draft">');
    expect(html).not.toContain('data-slot="editable-input"');
    expect(html).not.toContain('data-slot="editable-submit-trigger"');
  });

  it("renders TagsInput with its tags, its input, and a hidden input per tag", async () => {
    const html = await render(() =>
      h(TagsInput, { defaultValue: ["vue", "nuxt"], name: "stack" }, () => [
        ...["vue", "nuxt"].map((tag) =>
          h(TagsInputItem, { value: tag }, () => [h(TagsInputItemText, null, () => tag), h(TagsInputItemDelete)]),
        ),
        h(TagsInputInput),
        h(TagsInputClear),
      ]),
    );
    expect(html).toContain('data-slot="tags-input"');
    expect(html.match(/data-slot="tags-input-item"/g)).toHaveLength(2);
    expect(html).toMatch(
      /<button data-slot="tags-input-item-delete" type="button" tabindex="-1" id="([^"]+)-item-delete-vue" aria-labelledby="\1-item-delete-vue \1-item-text-vue">/,
    );
    expect(html).toMatch(/<span data-slot="tags-input-item-text" id="[^"]+-item-text-vue">vue<\/span>/);
    expect(html).toContain('<input data-slot="tags-input-input" type="text" autocomplete="off" autocapitalize="off">');
    expect(html.match(/type="hidden" name="stack" value="(vue|nuxt)"/g)).toHaveLength(2);
  });

  it("renders TagGroup as a grid with one tab stop", async () => {
    const html = await render(() =>
      h(TagGroup, { "aria-label": "Frameworks", selectionMode: "multiple", defaultValue: ["nuxt"] }, () =>
        ["vue", "nuxt"].map((tag) => h(TagGroupItem, { value: tag }, () => [tag, h(TagGroupItemRemove, null, () => "x")])),
      ),
    );
    expect(html).toMatch(/^<div aria-label="Frameworks" data-slot="tag-group" role="grid" aria-multiselectable="true">/);
    expect(html.match(/role="row" tabindex="0"/g)).toHaveLength(1);
    expect(html).toContain('<div data-slot="tag-group-item" role="row" tabindex="-1" aria-selected="true" data-selected>');
    expect(html.match(/<div role="gridcell" data-slot="tag-group-item-cell">/g)).toHaveLength(2);
  });

  it("renders Stepper with one tab stop, on the current step", async () => {
    const html = await render(() =>
      h(Stepper, { defaultValue: 2 }, () => [
        ...[1, 2, 3].map((step) =>
          h(StepperItem, { value: step }, () => [
            h(StepperTrigger, null, () => h(StepperIndicator, null, () => String(step))),
            h(StepperTitle, null, () => `Step ${step}`),
            h(StepperDescription),
            h(StepperSeparator),
          ]),
        ),
        h(StepperPrevious),
        h(StepperNext),
      ]),
    );
    expect(html).toMatch(/^<div data-slot="stepper" role="group" data-orientation="horizontal" data-linear>/);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).toMatch(/<button data-slot="stepper-trigger" type="button" tabindex="0" aria-current="step"/);
    expect(html).toContain('<div data-slot="stepper-item" data-current data-orientation="horizontal">');
    expect(html).toContain('data-slot="stepper-separator" aria-hidden="true"');
  });

  it("renders AspectRatio and VisuallyHidden with their styles", async () => {
    const html = await render(() => h("div", [h(AspectRatio, { ratio: 2 }), h(VisuallyHidden, null, () => "Close")]));
    expect(html).toContain('<div data-slot="aspect-ratio" style="aspect-ratio:2;--aspect-ratio:2;"></div>');
    expect(html).toMatch(/<span data-slot="visually-hidden" style="position:absolute;[^"]*clip-path:inset\(50%\);[^"]*">Close<\/span>/);
  });
});
