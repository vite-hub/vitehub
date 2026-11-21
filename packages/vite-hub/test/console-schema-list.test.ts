// @vitest-environment happy-dom
import { mount } from "@vue/test-utils"
import { defineComponent, h, ref } from "vue"
import { expect, it, vi } from "vitest"

import { describeConsoleSchemaFields } from "../src/console/runtime/client/schema-form"
import ConsoleSchemaList from "../src/console/runtime/components/console-schema-list.vue"

vi.mock("@vite-hub/ui", () => ({
  HoldToDelete: defineComponent({
    name: "HoldToDelete",
    props: ["commit"],
    emits: ["delete", "undo"],
    setup: () => () => h("button"),
  }),
  MotionList: defineComponent({
    props: { tag: { type: String, required: true } },
    setup: (props, { slots }) => () => h(props.tag, slots.default?.()),
  }),
}))

it("updates the submitted values before Undo expires and restores rows in list order", async () => {
  const [field] = describeConsoleSchemaFields({
    type: "object",
    properties: { authors: { type: "array", items: { type: "string", enum: ["Ada", "Lin", "Cora"] } } },
  })
  const values = ref(["Ada", "Lin", "Cora"])
  const wrapper = mount(defineComponent({
    setup: () => () => h(ConsoleSchemaList, {
      depth: 0,
      field: { ...field!, item: field!.item! },
      inputId: "authors",
      modelValue: values.value,
      "onUpdate:modelValue": (next: unknown) => { values.value = next as string[] },
    }),
  }), { global: { stubs: { UButton: true, Icon: true } } })
  try {
    const [ada, lin, cora] = wrapper.findAllComponents({ name: "HoldToDelete" })
    ada!.vm.$emit("delete")
    expect(values.value).toEqual(["Lin", "Cora"])
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain("Removed Ada")

    lin!.vm.$emit("delete")
    await wrapper.vm.$nextTick()
    ada!.vm.$emit("undo")
    await wrapper.vm.$nextTick()
    lin!.vm.$emit("undo")
    await wrapper.vm.$nextTick()
    expect(values.value).toEqual(["Ada", "Lin", "Cora"])

    cora!.vm.$emit("delete")
    await wrapper.vm.$nextTick()
    const submitted = values.value
    cora!.props("commit")()
    await wrapper.vm.$nextTick()
    expect(values.value).toBe(submitted)
    expect(wrapper.text()).not.toContain("Removed Cora")
  } finally {
    wrapper.unmount()
  }
})
