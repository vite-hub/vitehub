import { isRecord } from "./define.ts";
import { type CatalogDiagnostic, diagnostic, pointerSegment } from "./diagnostics.ts";
import { type CatalogSpec, type SpecActionBinding, type SpecElement, specVersion } from "./validate.ts";

/** The id of the A2UI v1.0 basic catalog. ViteHub components map to its components. */
export const a2uiBasicCatalogId = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";

/** One A2UI v1.0 component: an id, the component name, and its properties. */
export interface A2uiComponent {
  id: string;
  component: string;
  [property: string]: unknown;
}

/** The A2UI v1.0 messages that a spec converts to and from. */
export type A2uiMessage
  = | { version: "1.0"; createSurface: { surfaceId: string; catalogId: string; sendDataModel?: boolean; components?: A2uiComponent[]; dataModel?: Record<string, unknown> } }
    | { version: "1.0"; updateComponents: { surfaceId: string; components: A2uiComponent[] } }
    | { version: "1.0"; updateDataModel: { surfaceId: string; path?: string; value?: unknown } }
    | { version: "1.0"; deleteSurface: { surfaceId: string } };

export interface ToA2uiOptions {
  /** The A2UI surface id. It must be unique for the renderer's lifetime. */
  surfaceId: string;
}

export type ToA2uiResult = { ok: true; messages: A2uiMessage[] } | { ok: false; diagnostics: CatalogDiagnostic[] };
export type FromA2uiResult = { ok: true; spec: CatalogSpec } | { ok: false; diagnostics: CatalogDiagnostic[] };

const rootId = "root";

/** A literal stays a literal. A state read or binding becomes an A2UI data binding. */
function toDynamic(value: unknown): unknown {
  if (isRecord(value) && typeof value.$state === "string") return { "@path": value.$state };
  if (isRecord(value) && typeof value.$bindState === "string") return { "@path": value.$bindState };
  return value;
}

/** One line that A2UI Text shows as a Markdown heading, after any number of escaping backslashes. */
const headingLike = /^\\*#{1,4} [^\n]+$/;

/** A2UI Text reads Markdown. Plain text that a reader would take for a heading gets one more backslash. */
function toA2uiText(value: unknown): unknown {
  const text = toDynamic(value);
  return typeof text === "string" && headingLike.test(text) ? `\\${text}` : text;
}

function stringProp(props: Record<string, unknown>, name: string): string | undefined {
  const value = props[name];
  return typeof value === "string" ? value : undefined;
}

function defined(properties: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined));
}

/**
 * Converts a spec to A2UI v1.0 messages for the basic catalog: one `createSurface` with the state as its data model, and
 * one `updateComponents`. Run `validateSpec()` first. The root element becomes the A2UI `root` component.
 *
 * Every component of the portable subset converts and comes back unchanged through `fromA2ui()`. Form, Switch, and the
 * email and url types of Input convert one way. Badge, Dialog, Field, and Table have no A2UI component.
 */
export function toA2ui(spec: CatalogSpec, options: ToA2uiOptions): ToA2uiResult {
  const diagnostics: CatalogDiagnostic[] = [];
  const components: A2uiComponent[] = [];
  const ids = new Set(Object.keys(spec.elements));
  if (spec.root !== rootId && ids.has(rootId)) {
    diagnostics.push(diagnostic("KIT_R0013", { problem: `the element "${rootId}" is not the root, and A2UI reserves that id for the root.` }, `/elements/${rootId}`));
  }
  const a2uiId = (id: string) => id === spec.root ? rootId : id;
  // The A2UI parts that one element needs, such as the Text label of a Button, get ids after the element's id.
  const extra = (id: string, suffix: string) => {
    const extraId = `${a2uiId(id)}.${suffix}`;
    if (ids.has(extraId)) fail(extraId, `the element id "${extraId}" is taken by the A2UI conversion of "${id}".`);
    return extraId;
  };
  function fail(id: string, problem: string): void {
    diagnostics.push(diagnostic("KIT_R0013", { problem }, `/elements/${pointerSegment(id)}`));
  }
  const pressAction = (id: string, binding: SpecActionBinding | SpecActionBinding[] | undefined) => {
    if (!binding || Array.isArray(binding)) {
      fail(id, `"${id}" needs one action in on.press or on.submit, because an A2UI Button needs one action.`);
      return undefined;
    }
    const context = binding.params && Object.fromEntries(Object.entries(binding.params).map(([key, value]) => [key, toDynamic(value)]));
    return { event: defined({ name: binding.action, context }) };
  };

  for (const [id, element] of Object.entries(spec.elements)) {
    const props = element.props;
    const children = (element.children ?? []).map(a2uiId);
    const self = { id: a2uiId(id) };
    switch (element.type) {
      case "Stack":
        components.push({ ...self, component: props.direction === "horizontal" ? "Row" : "Column", ...defined({ children, align: props.align, justify: props.justify }) });
        break;
      case "Text":
        components.push({ ...self, component: "Text", ...defined({ text: toA2uiText(props.text), variant: props.tone === "muted" ? "caption" : undefined }) });
        break;
      case "Heading": {
        const level = typeof props.level === "number" ? props.level : 2;
        components.push({ ...self, component: "Text", text: `${"#".repeat(level)} ${stringProp(props, "text") ?? ""}` });
        break;
      }
      case "KeyValue":
        components.push(
          { ...self, component: "Column", children: [extra(id, "label"), extra(id, "value")] },
          { id: extra(id, "label"), component: "Text", text: toA2uiText(props.label), variant: "caption" },
          { id: extra(id, "value"), component: "Text", text: toA2uiText(props.value) },
        );
        break;
      case "Divider":
        components.push({ ...self, component: "Divider" });
        break;
      case "Card": {
        const title = stringProp(props, "title");
        const description = stringProp(props, "description");
        if (title === undefined && description === undefined && children.length === 1) {
          components.push({ ...self, component: "Card", child: children[0] });
          break;
        }
        const body = [...(title === undefined ? [] : [extra(id, "title")]), ...(description === undefined ? [] : [extra(id, "description")]), ...children];
        components.push({ ...self, component: "Card", child: extra(id, "body") }, { id: extra(id, "body"), component: "Column", children: body });
        if (title !== undefined) components.push({ id: extra(id, "title"), component: "Text", text: `### ${title}` });
        if (description !== undefined) components.push({ id: extra(id, "description"), component: "Text", text: toA2uiText(description), variant: "caption" });
        break;
      }
      case "Button": {
        const action = pressAction(id, element.on?.press);
        const variant = props.variant === "primary" ? "primary" : props.variant === "ghost" ? "borderless" : undefined;
        components.push({ ...self, component: "Button", ...defined({ child: extra(id, "label"), variant, action }) }, { id: extra(id, "label"), component: "Text", text: toA2uiText(props.label) });
        break;
      }
      case "Link":
        components.push(
          { ...self, component: "Button", child: extra(id, "label"), variant: "borderless", action: { functionCall: { "@call": "openUrl", "args": { url: props.href } } } },
          { id: extra(id, "label"), component: "Text", text: toA2uiText(props.text) },
        );
        break;
      case "Image":
        components.push({ ...self, component: "Image", url: props.src, description: props.alt });
        break;
      case "Input": {
        const variant = props.type === "password" ? "obscured" : props.type === "number" ? "number" : undefined;
        components.push({ ...self, component: "TextField", ...defined({ label: props.label, value: toDynamic(props.value), placeholder: props.placeholder, variant }) });
        break;
      }
      case "Textarea":
        components.push({ ...self, component: "TextField", ...defined({ label: props.label, value: toDynamic(props.value), placeholder: props.placeholder, variant: "longText" }) });
        break;
      case "Select":
        components.push({ ...self, component: "ChoicePicker", label: props.label, options: props.options, value: toDynamic(props.value) });
        break;
      case "RadioGroup":
        components.push({ ...self, component: "ChoicePicker", label: props.label, options: props.options, value: toDynamic(props.value), displayStyle: "checkbox" });
        break;
      case "Checkbox":
      case "Switch":
        components.push({ ...self, component: "CheckBox", label: props.label, value: toDynamic(props.checked) });
        break;
      case "Tabs": {
        const titles = Array.isArray(props.tabs) ? props.tabs : [];
        if (titles.length !== children.length) fail(id, `"${id}" has ${titles.length} tabs and ${children.length} children. A2UI needs one child for each tab.`);
        components.push({ ...self, component: "Tabs", tabs: titles.map((title, index) => ({ title, child: children[index] })) });
        break;
      }
      case "Form": {
        const action = pressAction(id, element.on?.submit);
        components.push(
          { ...self, component: "Column", children: [...children, extra(id, "submit")] },
          { id: extra(id, "submit"), component: "Button", child: extra(id, "submit.label"), variant: "primary", ...defined({ action }) },
          { id: extra(id, "submit.label"), component: "Text", text: toA2uiText(props.submitLabel) },
        );
        break;
      }
      default:
        fail(id, `${element.type} has no component in the A2UI basic catalog.`);
    }
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  const createSurface = { surfaceId: options.surfaceId, catalogId: a2uiBasicCatalogId, sendDataModel: true, ...(spec.state ? { dataModel: spec.state } : {}) };
  return {
    ok: true,
    messages: [
      { version: "1.0", createSurface },
      { version: "1.0", updateComponents: { surfaceId: options.surfaceId, components } },
    ],
  };
}

/** The keys that each A2UI component may have for the conversion to keep its meaning. Any other key fails. */
const a2uiKeys: Record<string, string[]> = {
  Column: ["children", "align", "justify"],
  Row: ["children", "align", "justify"],
  Text: ["text", "variant"],
  Card: ["child"],
  Divider: ["axis"],
  Button: ["child", "variant", "action"],
  Image: ["url", "description"],
  TextField: ["label", "value", "placeholder", "variant"],
  CheckBox: ["label", "value"],
  ChoicePicker: ["label", "options", "value", "variant", "displayStyle"],
  Tabs: ["tabs"],
};

/** A key that would reach an object's prototype instead of holding data. */
const unsafeKey = "__proto__";

/** Writes `value` as an own data property, so a key such as `__proto__` stays data. */
function writeOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

/** Writes `value` at an absolute JSON Pointer of `state`, through own properties only. */
function setPath(state: Record<string, unknown>, segments: string[], value: unknown): void {
  let target = state;
  for (const segment of segments.slice(0, -1)) {
    const next = Object.hasOwn(target, segment) ? target[segment] : undefined;
    const child = isRecord(next) ? next : {};
    if (child !== next) writeOwn(target, segment, child);
    target = child;
  }
  const last = segments.at(-1);
  if (last !== undefined) writeOwn(target, last, value);
}

/**
 * Converts A2UI v1.0 messages for one surface of the basic catalog to a spec. Run `validateSpec()` on the result for the
 * surface where it renders.
 */
export function fromA2ui(messages: readonly unknown[]): FromA2uiResult {
  const diagnostics: CatalogDiagnostic[] = [];
  const fail = (problem: string, path: string) => diagnostics.push(diagnostic("KIT_R0014", { problem }, path));
  const byId = new Map<string, A2uiComponent>();
  const state: Record<string, unknown> = {};
  let hasState = false;
  let surfaceId: string | undefined;
  const addComponents = (list: unknown, path: string) => {
    if (!Array.isArray(list)) return fail("components must be a list.", path);
    list.forEach((component, index) => {
      if (!isRecord(component) || typeof component.id !== "string" || typeof component.component !== "string") return fail("a component needs a string id and component.", `${path}/${index}`);
      if (component.id === unsafeKey) return fail(`the component id "${unsafeKey}" is not allowed.`, `${path}/${index}/id`);
      byId.set(component.id, { ...component, id: component.id, component: component.component });
    });
  };
  const mergeRoot = (value: Record<string, unknown>, path: string) => {
    for (const [key, item] of Object.entries(value)) {
      if (key === unsafeKey) fail(`the data model uses the key "${unsafeKey}".`, `${path}/${unsafeKey}`);
      else writeOwn(state, key, item);
    }
  };
  const sameSurface = (id: unknown, path: string) => {
    if (typeof id !== "string") return fail("a message needs a surfaceId.", path);
    if (surfaceId !== undefined && id !== surfaceId) fail(`the messages are for more than one surface: "${surfaceId}" and "${id}".`, path);
    surfaceId ??= id;
  };

  messages.forEach((message, index) => {
    const at = `/${index}`;
    if (!isRecord(message) || message.version !== "1.0") return fail("each message needs \"version\": \"1.0\".", at);
    if (isRecord(message.createSurface)) {
      const { catalogId, components, dataModel } = message.createSurface;
      sameSurface(message.createSurface.surfaceId, `${at}/createSurface`);
      if (catalogId !== a2uiBasicCatalogId) fail(`the catalog "${String(catalogId)}" is not the A2UI basic catalog.`, `${at}/createSurface/catalogId`);
      if (components !== undefined) addComponents(components, `${at}/createSurface/components`);
      if (isRecord(dataModel)) {
        mergeRoot(dataModel, `${at}/createSurface/dataModel`);
        hasState = true;
      }
    }
    else if (isRecord(message.updateComponents)) {
      sameSurface(message.updateComponents.surfaceId, `${at}/updateComponents`);
      addComponents(message.updateComponents.components, `${at}/updateComponents/components`);
    }
    else if (isRecord(message.updateDataModel)) {
      const { path, value } = message.updateDataModel;
      sameSurface(message.updateDataModel.surfaceId, `${at}/updateDataModel`);
      if (path === undefined || path === "/") {
        if (isRecord(value)) mergeRoot(value, `${at}/updateDataModel/value`);
        else fail("a data model update of the root needs an object value.", `${at}/updateDataModel/value`);
      }
      else if (typeof path === "string" && path.startsWith("/")) {
        const segments = path.split("/").slice(1).map(segment => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
        if (segments.includes(unsafeKey)) fail(`the data model path "${path}" uses the key "${unsafeKey}".`, `${at}/updateDataModel/path`);
        else setPath(state, segments, value);
      }
      else fail(`the data model path "${String(path)}" is not an absolute JSON Pointer.`, `${at}/updateDataModel/path`);
      hasState = true;
    }
    else if (!isRecord(message.deleteSurface)) {
      fail(`the message has no createSurface, updateComponents, updateDataModel, or deleteSurface.`, at);
    }
  });
  if (!byId.has(rootId)) fail("no component has the id \"root\".", "");
  if (diagnostics.length) return { ok: false, diagnostics };

  const elements: Record<string, SpecElement> = {};
  const component = (id: string, path: string) => {
    const found = byId.get(id);
    if (!found) fail(`no component has the id "${id}".`, path);
    return found;
  };
  /** A literal, or a state read for an A2UI data binding. */
  const dynamic = (value: unknown, path: string, binding: "$state" | "$bindState" = "$state"): unknown => {
    if (!isRecord(value)) return value;
    if (typeof value["@path"] === "string" && value["@path"].startsWith("/") && Object.keys(value).length === 1) return { [binding]: value["@path"] };
    fail("only literals and absolute {\"@path\"} bindings convert. Function calls do not.", path);
    return undefined;
  };
  const text = (value: unknown, path: string): unknown => {
    const read = dynamic(value, path);
    return typeof read === "string" && read.startsWith("\\") && headingLike.test(read) ? read.slice(1) : read;
  };
  const textOf = (id: unknown, path: string): unknown => {
    const child = typeof id === "string" ? component(id, path) : undefined;
    if (child && child.component !== "Text") fail(`the child "${child.id}" is not a Text. Only a Text labels a Button.`, path);
    return child ? text(child.text, path) : undefined;
  };
  const action = (value: unknown, path: string): SpecActionBinding | undefined => {
    if (!isRecord(value) || !isRecord(value.event) || typeof value.event.name !== "string" || Object.keys(value.event).some(key => key !== "name" && key !== "context")) {
      fail("only an action with an event name and context converts.", path);
      return undefined;
    }
    const context = value.event.context;
    const params = isRecord(context) ? Object.fromEntries(Object.entries(context).map(([key, item]) => [key, dynamic(item, `${path}/event/context/${key}`)])) : undefined;
    return { action: value.event.name, ...(params ? { params } : {}) };
  };

  const visited = new Set<string>();
  const visit = (id: string, path: string): string => {
    const node = byId.get(id);
    const elementId = id;
    if (!node) {
      fail(`no component has the id "${id}".`, path);
      return elementId;
    }
    if (visited.has(id)) {
      fail(`the component "${id}" appears twice in the tree.`, path);
      return elementId;
    }
    visited.add(id);
    for (const key of Object.keys(node)) {
      if (key !== "id" && key !== "component" && !a2uiKeys[node.component]?.includes(key)) fail(`${node.component} property "${key}" has no ViteHub mapping.`, `${path}/${key}`);
    }
    const list = (children: unknown) => {
      if (!Array.isArray(children)) {
        fail("only a static list of children converts. Templates do not.", `${path}/children`);
        return [];
      }
      return children.filter((child): child is string => typeof child === "string").map(child => visit(child, `${path}/children`));
    };
    switch (node.component) {
      case "Column":
      case "Row": {
        const children = Array.isArray(node.children) ? node.children : [];
        const label = byId.get(`${id}.label`);
        const value = byId.get(`${id}.value`);
        if (node.component === "Column" && children.length === 2 && children[0] === `${id}.label` && children[1] === `${id}.value` && label?.component === "Text" && label.variant === "caption" && value?.component === "Text") {
          elements[elementId] = { type: "KeyValue", props: { label: text(label.text, path), value: text(value.text, path) } };
          break;
        }
        if (node.justify !== undefined && !["start", "center", "end", "spaceBetween"].includes(String(node.justify))) fail(`justify "${String(node.justify)}" has no ViteHub mapping.`, `${path}/justify`);
        const props = defined({ direction: node.component === "Row" ? "horizontal" : undefined, align: node.align, justify: node.justify });
        elements[elementId] = { type: "Stack", props, children: [] };
        elements[elementId].children = list(node.children);
        break;
      }
      case "Text": {
        const value = text(node.text, path);
        const heading = typeof node.text === "string" ? /^(#{1,4}) ([^\n]+)$/.exec(node.text) : null;
        if (heading && node.variant === undefined) {
          const level = heading[1]!.length;
          elements[elementId] = { type: "Heading", props: { text: heading[2], ...(level === 2 ? {} : { level }) } };
          break;
        }
        elements[elementId] = { type: "Text", props: defined({ text: value, tone: node.variant === "caption" ? "muted" : undefined }) };
        break;
      }
      case "Card": {
        const body = typeof node.child === "string" ? byId.get(node.child) : undefined;
        if (node.child === `${id}.body` && body?.component === "Column" && Array.isArray(body.children)) {
          const rest = body.children.filter((child): child is string => typeof child === "string");
          const props: Record<string, unknown> = {};
          if (rest[0] === `${id}.title`) {
            const title = textOf(rest.shift(), path);
            props.title = typeof title === "string" ? title.replace(/^### /, "") : title;
          }
          if (rest[0] === `${id}.description`) props.description = textOf(rest.shift(), path);
          elements[elementId] = { type: "Card", props, children: [] };
          elements[elementId].children = rest.map(child => visit(child, `${path}/child`));
          break;
        }
        elements[elementId] = { type: "Card", props: {}, children: [] };
        elements[elementId].children = typeof node.child === "string" ? [visit(node.child, `${path}/child`)] : [];
        break;
      }
      case "Divider":
        if (node.axis !== undefined && node.axis !== "horizontal") fail("only a horizontal Divider converts.", `${path}/axis`);
        elements[elementId] = { type: "Divider", props: {} };
        break;
      case "Button": {
        const label = textOf(node.child, `${path}/child`);
        const call = isRecord(node.action) && isRecord(node.action.functionCall) ? node.action.functionCall : undefined;
        if (call) {
          if (call["@call"] !== "openUrl" || !isRecord(call.args)) fail("only the openUrl function converts, to a Link.", `${path}/action`);
          elements[elementId] = { type: "Link", props: { text: label, href: isRecord(call.args) ? call.args.url : undefined } };
          break;
        }
        const variant = node.variant === "primary" ? "primary" : node.variant === "borderless" ? "ghost" : undefined;
        const press = action(node.action, `${path}/action`);
        elements[elementId] = { type: "Button", props: defined({ label, variant }), ...(press ? { on: { press } } : {}) };
        break;
      }
      case "Image":
        elements[elementId] = { type: "Image", props: { src: dynamic(node.url, `${path}/url`), alt: node.description === undefined ? "" : dynamic(node.description, `${path}/description`) } };
        break;
      case "TextField": {
        const variant = node.variant;
        const value = dynamic(node.value, `${path}/value`, "$bindState");
        const base = defined({ label: dynamic(node.label, `${path}/label`), value, placeholder: dynamic(node.placeholder, `${path}/placeholder`) });
        if (variant === "longText") elements[elementId] = { type: "Textarea", props: base };
        else if (variant === undefined || variant === "shortText") elements[elementId] = { type: "Input", props: base };
        else elements[elementId] = { type: "Input", props: { ...base, type: variant === "obscured" ? "password" : "number" } };
        break;
      }
      case "CheckBox":
        elements[elementId] = { type: "Checkbox", props: { label: dynamic(node.label, `${path}/label`), checked: dynamic(node.value, `${path}/value`, "$bindState") } };
        break;
      case "ChoicePicker": {
        if (node.variant !== undefined && node.variant !== "mutuallyExclusive") fail("only a ChoicePicker with one choice converts.", `${path}/variant`);
        if (node.displayStyle !== undefined && node.displayStyle !== "checkbox") fail(`displayStyle "${String(node.displayStyle)}" has no ViteHub mapping.`, `${path}/displayStyle`);
        const props = { label: dynamic(node.label, `${path}/label`), value: dynamic(node.value, `${path}/value`, "$bindState"), options: node.options };
        elements[elementId] = { type: node.displayStyle === "checkbox" ? "RadioGroup" : "Select", props };
        break;
      }
      case "Tabs": {
        const tabs = Array.isArray(node.tabs) ? node.tabs.filter(isRecord) : [];
        elements[elementId] = { type: "Tabs", props: { tabs: tabs.map((tab, index) => text(tab.title, `${path}/tabs/${index}/title`)) }, children: [] };
        elements[elementId].children = tabs.map((tab, index) => visit(String(tab.child), `${path}/tabs/${index}/child`));
        break;
      }
      default:
        fail(`${node.component} has no ViteHub mapping.`, path);
    }
    return elementId;
  };
  visit(rootId, "/components/root");
  if (diagnostics.length) return { ok: false, diagnostics };
  return { ok: true, spec: { version: specVersion, root: rootId, elements, ...(hasState ? { state } : {}) } };
}
