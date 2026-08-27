import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { AgentInvocationList, type AgentInvocationListItem } from '@vite-hub/ui'
import { createRenderer, h, type RendererOptions } from 'vue'

interface HostNode {
  children: HostNode[]
  clientHeight: number
  parent?: HostNode
  props: Record<string, unknown>
  querySelector: (selector: string) => HostNode | null
  scrollHeight: number
  scrollTop: number
  text?: string
  type: string
}

const node = (type: string, text?: string): HostNode => ({
  children: [],
  clientHeight: 800,
  props: {},
  querySelector: () => null,
  scrollHeight: 1_200,
  scrollTop: 0,
  text,
  type,
})

const renderer = createRenderer<HostNode, HostNode>({
  createComment: text => node('#comment', text),
  createElement: type => node(type),
  createText: text => node('#text', text),
  insert(child, parent, anchor) {
    child.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(child)
    else parent.children.splice(index, 0, child)
  },
  insertStaticContent(content, parent, anchor) {
    const child = node('#static', content)
    this.insert(child, parent, anchor)
    return [child, child]
  },
  nextSibling(child) {
    if (!child.parent) return null
    const index = child.parent.children.indexOf(child)
    return child.parent.children[index + 1] ?? null
  },
  parentNode: child => child.parent ?? null,
  patchProp(element, key, _previous, value) {
    element.props[key] = value
  },
  querySelector: () => null,
  remove(child) {
    if (!child.parent) return
    const index = child.parent.children.indexOf(child)
    if (index >= 0) child.parent.children.splice(index, 1)
  },
  setElementText(element, text) {
    const child = node('#text', text)
    child.parent = element
    element.children = [child]
  },
  setScopeId() {},
  setText(child, text) {
    child.text = text
  },
} satisfies RendererOptions<HostNode, HostNode>)

function findAll(root: HostNode, predicate: (candidate: HostNode) => boolean, matches: HostNode[] = []) {
  if (predicate(root)) matches.push(root)
  for (const child of root.children) findAll(child, predicate, matches)
  return matches
}

function invocation(id: string, status: AgentInvocationListItem['status'], updatedAt: string): AgentInvocationListItem {
  return { id, status, title: id, updatedAt }
}

function renderList(selectedId?: string) {
  const root = node('#root')
  renderer.createApp({
    render: () => h(AgentInvocationList, {
      items: [
        invocation('done-old', 'completed', '2026-08-20T00:00:00Z'),
        invocation('queued-old', 'pending', '2026-08-21T00:00:00Z'),
        invocation('working-old', 'running', '2026-08-22T00:00:00Z'),
        invocation('done-new', 'failed', '2026-08-24T00:00:00Z'),
        invocation('queued-new', 'pending', '2026-08-25T00:00:00Z'),
        invocation('working-new', 'running', '2026-08-26T00:00:00Z'),
      ],
      selectedId,
    }),
  }).mount(root)
  return root
}

function groupRows(group: HostNode) {
  return findAll(group, candidate => candidate.type === 'strong').map(title => title.children[0]?.text)
}

test('console sessions are grouped by lifecycle with collapsible queued and done sections', () => {
  const groups = findAll(
    renderList(),
    candidate => ['section', 'details'].includes(candidate.type) && ['working', 'queued', 'done'].includes(String(candidate.props['data-group'])),
  )

  assert.deepEqual(groups.map(group => group.props['data-group']), ['working', 'queued', 'done'])
  assert.deepEqual(groups.map(group => group.type), ['section', 'details', 'details'])
  assert.equal(groups[1]?.props.open, true)
  assert.equal(groups[2]?.props.open, false)
  assert.deepEqual(groupRows(groups[0]!), ['working-new', 'working-old'])
  assert.deepEqual(groupRows(groups[1]!), ['queued-new', 'queued-old'])
  assert.deepEqual(groupRows(groups[2]!), ['done-new', 'done-old'])
})

test('the selected done session is revealed', () => {
  const done = findAll(renderList('done-new'), candidate => candidate.type === 'details' && candidate.props['data-group'] === 'done')[0]
  assert.equal(done?.props.open, true)
})
