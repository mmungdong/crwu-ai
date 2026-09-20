import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'


export function createRenderer() {
  const instances = new Map()
  let current = null

  const React = {
    createElement(type, rawProps, ...children) {
      const props = { ...(rawProps || {}) }
      const key = props.key
      delete props.key
      props.children = children.length <= 1 ? children[0] : children
      return { type, key, props }
    },
    useState(initial) {
      const instance = current
      const index = instance.cursor++
      if (!(index in instance.hooks)) {
        instance.hooks[index] = typeof initial === 'function' ? initial() : initial
      }
      const setValue = (next) => {
        instance.hooks[index] = typeof next === 'function' ? next(instance.hooks[index]) : next
      }
      return [instance.hooks[index], setValue]
    },
    useEffect() {},
  }

  function renderComponent(component, props, id) {
    const instance = instances.get(id) || { hooks: [], cursor: 0 }
    instance.cursor = 0
    instances.set(id, instance)
    const previous = current
    current = instance
    try {
      return component(props || {})
    } finally {
      current = previous
    }
  }

  function resolve(node, path = 'root') {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return node
    if (Array.isArray(node)) return node.map((child, index) => resolve(child, `${path}.${index}`))
    if (typeof node.type === 'function') {
      const id = `${path}:${node.key ?? node.type.name}`
      return resolve(renderComponent(node.type, node.props, id), id)
    }
    return {
      ...node,
      props: {
        ...node.props,
        children: resolve(node.props.children, `${path}.children`),
      },
    }
  }

  return {
    React,
    renderRoot(component) {
      return resolve(renderComponent(component, {}, 'root'))
    },
    setComponentHook(componentName, index, value) {
      const entry = Array.from(instances.entries()).find(([id]) => id.endsWith(`:${componentName}`))
      assert.ok(entry, `render ${componentName} before overriding hook state`)
      entry[1].hooks[index] = value
    },
  }
}

export function textContent(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textContent).join('')
  return textContent(node.props && node.props.children)
}

export function findButton(node, label) {
  if (!node) return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, label)
      if (found) return found
    }
    return null
  }
  if (typeof node !== 'object') return null
  if (node.type === 'button' && textContent(node) === label) return node
  return findButton(node.props && node.props.children, label)
}

export function findButtons(node, label, found = []) {
  if (!node) return found
  if (Array.isArray(node)) {
    for (const child of node) findButtons(child, label, found)
    return found
  }
  if (typeof node !== 'object') return found
  if (node.type === 'button' && textContent(node) === label) found.push(node)
  findButtons(node.props && node.props.children, label, found)
  return found
}

export async function loadWorkbench(renderer, hostCall = () => Promise.resolve({ ok: true })) {
  const source = await readFile(new URL('../../legacy/client.js', import.meta.url), 'utf8')
  let mainComponent = null
  const slots = {
    inject(_name, register) { return register() },
    register(meta, component) {
      if (meta.name === 'main') mainComponent = component
      return () => {}
    },
  }
  const ctx = {
    get(name) {
      if (name === 'slots') return slots
      if (name === 'layout') return { selectPanel() {} }
      return undefined
    },
    interval() { return () => {} },
  }
  const plugin = new Function('ctx', 'React', 'host', 'styles', 'console', source)(
    ctx,
    renderer.React,
    { call: hostCall },
    { insert() {} },
    { log() {} },
  )
  plugin.apply(ctx)
  assert.equal(typeof mainComponent, 'function')
  return mainComponent
}
