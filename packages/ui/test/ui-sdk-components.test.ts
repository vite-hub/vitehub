import { renderToString } from "@vue/server-renderer";
import { describe, expect, it } from "vitest";
import { createSSRApp, defineComponent, h } from "vue";
import { CopyButton } from "../src/components/copy-button.ts";
import { createViteHubUI } from "../src/config.ts";
import { uiSdkComponents } from "../src/ui-sdk/components.ts";

const CustomIcon = defineComponent({
  props: { name: String },
  setup: props => () => h("span", { "data-custom-icon": props.name }),
});

describe("ui-sdk adapter icons", () => {
  it("uses the configured icon inside CopyButton", async () => {
    const app = createSSRApp({ render: () => h(CopyButton, { value: "Copy this" }) });
    app.use(createViteHubUI({ components: { ...uiSdkComponents, UIcon: CustomIcon }, icons: { copy: "custom:copy" } }));
    expect(await renderToString(app)).toContain('data-custom-icon="custom:copy"');
  });

  it("uses the configured icon for leading, trailing, loading and tab icons", async () => {
    const app = createSSRApp({ render: () => h("div", [
      h(uiSdkComponents.UButton!, { icon: "custom:leading", trailingIcon: "custom:trailing" }),
      h(uiSdkComponents.UButton!, { loading: true }),
      h(uiSdkComponents.UTabs!, { items: [{ icon: "custom:tab", label: "Files", value: "files" }] }),
    ]) });
    app.use(createViteHubUI({ components: { ...uiSdkComponents, UIcon: CustomIcon } }));
    const html = await renderToString(app);
    for (const name of ["custom:leading", "custom:trailing", "i-lucide-loader-circle", "custom:tab"]) {
      expect(html).toContain(`data-custom-icon="${name}"`);
    }
  });

  it("keeps bundled Lucide shapes without an override", async () => {
    const app = createSSRApp({ render: () => h(CopyButton, { value: "Copy this" }) });
    app.use(createViteHubUI({ components: uiSdkComponents }));
    const html = await renderToString(app);
    expect(html).toContain("<svg");
    expect(html).toContain("<path");
  });
});
