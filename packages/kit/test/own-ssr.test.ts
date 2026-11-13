import { createSSRApp, h, type VNode } from "vue";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";

import { Field, FieldControl, FieldError } from "@vite-hub/kit/field";
import { Form } from "@vite-hub/kit/form";
import {
  TagsInput,
  TagsInputClear,
  TagsInputInput,
  TagsInputItem,
  TagsInputItemDelete,
  TagsInputItemText,
} from "@vite-hub/kit/tags-input";

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
});
