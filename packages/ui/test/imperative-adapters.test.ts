// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface TreeModelStub {
  cleanUp: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  resetPaths: ReturnType<typeof vi.fn>;
  unmount: ReturnType<typeof vi.fn>;
}

interface DiffModelStub {
  cleanUp: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  setOptions: ReturnType<typeof vi.fn>;
}

const treeState = vi.hoisted(() => ({ instances: [] as TreeModelStub[] }));
const diffState = vi.hoisted(() => ({ instances: [] as DiffModelStub[] }));

vi.mock("@pierre/trees", () => ({
  FILE_TREE_TAG_NAME: "div",
  FileTree: class {
    cleanUp = vi.fn();
    getDensityFactor = vi.fn(() => 1);
    getItemHeight = vi.fn(() => 24);
    getSelectedPaths = vi.fn(() => []);
    render = vi.fn(({ fileTreeContainer }: { fileTreeContainer: HTMLElement }) => {
      const shadow = fileTreeContainer.shadowRoot ?? fileTreeContainer.attachShadow({ mode: "open" });
      shadow.innerHTML = '<div role="tree"></div>';
    });
    resetPaths = vi.fn();
    subscribe = vi.fn(() => vi.fn());
    unmount = vi.fn();

    constructor() {
      treeState.instances.push(this);
    }
  },
}));

vi.mock("@pierre/diffs", () => ({
  DIFFS_TAG_NAME: "div",
  FileDiff: class {
    host?: HTMLElement;
    cleanUp = vi.fn(() => this.host?.replaceChildren());
    render = vi.fn(({ fileContainer, fileDiff }) => {
      this.host = fileContainer;
      fileContainer.textContent = fileDiff.name;
    });
    setOptions = vi.fn();
    setSelectedLines = vi.fn();

    constructor() {
      diffState.instances.push(this);
    }
  },
  getSingularPatch: (patch: string) => ({ name: patch }),
}));

import { FileTree } from "@pierre/trees";
import { AgentDiff } from "../src/components/agent-diff.ts";
import { AgentFileTree } from "../src/components/agent-file-tree.ts";
import { PierreDiff } from "../src/internal/pierre-diff.ts";

async function flushRender(): Promise<void> {
  await nextTick();
  await Promise.resolve();
}

beforeEach(() => {
  treeState.instances.length = 0;
  diffState.instances.length = 0;
});

describe("Pierre lifecycle adapters", () => {
  it("names the tree inside Pierre's shadow boundary", () => {
    const wrapper = mount(AgentFileTree, { attrs: { "aria-label": "Repository files" }, props: { paths: ["first.ts"] } });
    const tree = wrapper.element.shadowRoot?.querySelector("[role='tree']");

    expect(tree?.getAttribute("aria-label")).toBe("Repository files");
  });

  it("disables Pierre's pointer-only diff interactions", async () => {
    // SAFETY: Bypass the public type to prove the runtime guard also protects JavaScript consumers.
    const unsafeOptions = { enableLineSelection: true, expandUnchanged: false } as never;
    mount(AgentDiff, {
      props: {
        options: unsafeOptions,
        patch: "first.patch",
      },
    });
    await flushRender();

    expect(diffState.instances[0]!.setOptions)
      .toHaveBeenCalledWith(expect.objectContaining({ enableLineSelection: false, expandUnchanged: true }));
  });

  it("keeps normalized diff options stable across unrelated updates", async () => {
    const options = { theme: "light" } as never;
    const wrapper = mount(AgentDiff, { props: { options, patch: "first.patch" } });
    await flushRender();
    const normalized = wrapper.getComponent(PierreDiff).props("options");

    wrapper.vm.$forceUpdate();
    await flushRender();

    expect(wrapper.getComponent(PierreDiff).props("options")).toBe(normalized);
  });

  it("unmounts external FileTree models and cleans up component-owned replacements", async () => {
    new FileTree({ paths: ["first.ts"] });
    const first = treeState.instances[0]!;
    new FileTree({ paths: ["second.ts"] });
    const second = treeState.instances[1]!;
    const wrapper = mount(AgentFileTree, { props: { model: first as never } });

    expect(first.render).toHaveBeenCalledOnce();
    await wrapper.setProps({ model: second as never });
    expect(first.unmount).toHaveBeenCalledOnce();
    expect(first.cleanUp).not.toHaveBeenCalled();
    expect(second.render).toHaveBeenCalled();

    await wrapper.setProps({ model: undefined, paths: ["owned.ts"] });
    const owned = treeState.instances.at(-1)!;
    expect(second.unmount).toHaveBeenCalledOnce();
    expect(owned.render).toHaveBeenCalled();

    await wrapper.setProps({ model: first as never });
    expect(owned.cleanUp).toHaveBeenCalledOnce();
    expect(first.render).toHaveBeenCalled();

    wrapper.unmount();
    expect(first.unmount).toHaveBeenCalledTimes(2);
    expect(first.cleanUp).not.toHaveBeenCalled();
  });

  it("cleans up the active component-owned FileTree model on teardown", () => {
    const wrapper = mount(AgentFileTree, { props: { paths: ["owned.ts"] } });
    const owned = treeState.instances[0]!;

    wrapper.unmount();

    expect(owned.cleanUp).toHaveBeenCalledOnce();
    expect(owned.unmount).not.toHaveBeenCalled();
  });

  it("clears an empty diff and creates a valid instance for later input", async () => {
    const wrapper = mount(PierreDiff, { props: { patch: "first.patch" } });
    await flushRender();

    const first = diffState.instances[0]!;
    expect(wrapper.text()).toBe("first.patch");
    await wrapper.setProps({ patch: undefined });
    await flushRender();
    expect(first.cleanUp).toHaveBeenCalledOnce();
    expect(wrapper.text()).toBe("");

    await wrapper.setProps({ patch: "second.patch" });
    await flushRender();
    const second = diffState.instances[1]!;
    expect(second).toBeDefined();
    expect(second.render).toHaveBeenCalled();
    expect(wrapper.text()).toBe("second.patch");

    wrapper.unmount();
    expect(second.cleanUp).toHaveBeenCalledOnce();
  });
});
