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
  setSelectedLines: ReturnType<typeof vi.fn>;
}

interface CodeViewModelStub {
  cleanUp: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  setItems: ReturnType<typeof vi.fn>;
  setOptions: ReturnType<typeof vi.fn>;
  setSelectedLines: ReturnType<typeof vi.fn>;
  setup: ReturnType<typeof vi.fn>;
}

const treeState = vi.hoisted(() => ({ instances: [] as TreeModelStub[] }));
const codeViewState = vi.hoisted(() => ({ instances: [] as CodeViewModelStub[] }));
const diffState = vi.hoisted(() => ({
  files: [] as DiffModelStub[],
  diffs: [] as DiffModelStub[],
  unresolvedFiles: [] as DiffModelStub[],
}));

vi.mock("@pierre/trees", () => ({
  FILE_TREE_TAG_NAME: "div",
  FileTree: class {
    cleanUp = vi.fn();
    getDensityFactor = vi.fn(() => 1);
    getItemHeight = vi.fn(() => 24);
    getSelectedPaths = vi.fn(() => []);
    render = vi.fn();
    resetPaths = vi.fn();
    subscribe = vi.fn(() => vi.fn());
    unmount = vi.fn();

    constructor() {
      treeState.instances.push(this);
    }
  },
}));

vi.mock("@pierre/diffs", () => ({
  CodeView: class {
    cleanUp = vi.fn();
    render = vi.fn();
    setItems = vi.fn();
    setOptions = vi.fn();
    setSelectedLines = vi.fn();
    setup = vi.fn();

    constructor() {
      codeViewState.instances.push(this);
    }
  },
  DIFFS_TAG_NAME: "div",
  File: class {
    host?: HTMLElement;
    cleanUp = vi.fn(() => this.host?.replaceChildren());
    render = vi.fn(({ fileContainer, file }) => {
      this.host = fileContainer;
      fileContainer.textContent = file.name;
    });
    setOptions = vi.fn();
    setSelectedLines = vi.fn();

    constructor() {
      diffState.files.push(this);
    }
  },
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
      diffState.diffs.push(this);
    }
  },
  UnresolvedFile: class {
    host?: HTMLElement;
    cleanUp = vi.fn(() => this.host?.replaceChildren());
    render = vi.fn(({ fileContainer, file }) => {
      this.host = fileContainer;
      fileContainer.textContent = file.name;
    });
    setOptions = vi.fn();
    setSelectedLines = vi.fn();

    constructor() {
      diffState.unresolvedFiles.push(this);
    }
  },
  getSingularPatch: (patch: string) => ({ name: patch }),
  parseDiffFromFile: (oldFile: { name?: string } | null, newFile: { name?: string } | null) => ({
    name: `${oldFile?.name ?? "missing"}->${newFile?.name ?? "missing"}`,
  }),
}));

import { FileTree } from "@pierre/trees";
import { AgentFileTree } from "../src/components/agent-file-tree.ts";
import {
  PierreCodeView,
  PierreDiff,
  PierreFile,
  PierreUnresolvedFile,
} from "../src/internal/pierre-code-view.ts";

async function flushRender(): Promise<void> {
  await nextTick();
  await Promise.resolve();
}

beforeEach(() => {
  treeState.instances.length = 0;
  codeViewState.instances.length = 0;
  diffState.files.length = 0;
  diffState.diffs.length = 0;
  diffState.unresolvedFiles.length = 0;
});

describe("Pierre lifecycle adapters", () => {
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

    const first = diffState.diffs[0]!;
    expect(wrapper.text()).toBe("first.patch");
    await wrapper.setProps({ patch: undefined });
    await flushRender();
    expect(first.cleanUp).toHaveBeenCalledOnce();
    expect(wrapper.text()).toBe("");

    await wrapper.setProps({ patch: "second.patch" });
    await flushRender();
    const second = diffState.diffs[1]!;
    expect(second).toBeDefined();
    expect(second.render).toHaveBeenCalled();
    expect(wrapper.text()).toBe("second.patch");

    wrapper.unmount();
    expect(second.cleanUp).toHaveBeenCalledOnce();
  });

  it("renders file-content comparisons and forwards controlled selection", async () => {
    const selectedLines = { end: 2, start: 1 };
    const wrapper = mount(PierreDiff, {
      props: {
        newFile: { contents: "new", name: "new.ts" },
        oldFile: null,
        selectedLines,
      },
    });
    await flushRender();

    const instance = diffState.diffs[0]!;
    expect(wrapper.text()).toBe("missing->new.ts");
    expect(instance.setSelectedLines).toHaveBeenLastCalledWith(selectedLines);

    wrapper.unmount();
    expect(instance.cleanUp).toHaveBeenCalledOnce();
  });

  it("owns File and UnresolvedFile lifecycles", async () => {
    const fileWrapper = mount(PierreFile, {
      props: { file: { contents: "const ready = true", name: "ready.ts" } },
    });
    const unresolvedWrapper = mount(PierreUnresolvedFile, {
      props: { file: { contents: "<<<<<<< current", name: "conflict.ts" } },
    });
    await flushRender();

    expect(fileWrapper.text()).toBe("ready.ts");
    expect(unresolvedWrapper.text()).toBe("conflict.ts");
    fileWrapper.unmount();
    unresolvedWrapper.unmount();
    expect(diffState.files[0]!.cleanUp).toHaveBeenCalledOnce();
    expect(diffState.unresolvedFiles[0]!.cleanUp).toHaveBeenCalledOnce();
  });

  it("sets up and cleans the virtualized CodeView model", async () => {
    const items = [{ file: { contents: "ok", name: "status.ts" }, id: "status", type: "file" }] as const;
    const wrapper = mount(PierreCodeView, { props: { items } });
    await flushRender();

    const instance = codeViewState.instances[0]!;
    expect(instance.setup).toHaveBeenCalledOnce();
    expect(instance.setItems).toHaveBeenLastCalledWith(items);
    expect(instance.render).toHaveBeenLastCalledWith(true);

    wrapper.unmount();
    expect(instance.cleanUp).toHaveBeenCalledOnce();
  });
});
