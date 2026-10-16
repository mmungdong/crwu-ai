/**
 * Shared popover contract (src/client/ui/components/Popover.tsx).
 *
 * Regression this file pins: `usePopover.place` must calibrate the containing-block
 * displacement from the ACTUAL rendered inline `left`/`top` and the element's own rect from
 * the same DOM epoch. It must not compare a pending target box against the previous DOM
 * render, and it must assign (not accumulate) the offset, so repeated scroll/effect `place`
 * calls before the next commit cannot drift the popup offscreen.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { registerTsxLoader } from '../../helpers/tsx-loader.mjs'

registerTsxLoader()

const ROOT = new URL('../../../', import.meta.url)
const POPOVER_ENTRY = new URL('src/client/ui/components/Popover.tsx', ROOT).href
const MODEL_ENTRY = new URL('src/client/ui/components/popover-model.ts', ROOT).href

const { React, render, rerender } = await import(new URL('tests/helpers/render.mjs', ROOT).href)
const { usePopover } = await import(POPOVER_ENTRY)
const {
  POPOVER_GAP, POPOVER_MARGIN, POPOVER_MAX_HEIGHT, POPOVER_MIN_HEIGHT, placementOf,
} = await import(MODEL_ENTRY)

const VIEW = { innerWidth: 375, innerHeight: 667 }
const VIEW_RECT = { left: 0, top: 0, right: 375, bottom: 667, width: 375 }

function anchorNode(rect) {
  return {
    getBoundingClientRect: () => ({ ...rect }),
    ownerDocument: { defaultView: VIEW },
    parentElement: null,
    contains: () => false,
  }
}

function contentNode() {
  return {
    scrollHeight: 240,
    style: { left: '', top: '' },
    rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0 },
    getBoundingClientRect() { return { ...this.rect } },
    contains: () => false,
  }
}

let captured = null
function Harness(props) {
  captured = usePopover({
    open: true,
    anchorRef: props.anchorRef,
    listRef: props.listRef,
    contentHeightRef: props.contentHeightRef,
    insideSelector: '[data-crwu-test-inside]',
    onRequestClose: () => {},
  })
  return React.createElement('div', null, 'popover')
}

function mount(anchorRef, listRef) {
  const contentHeightRef = { current: 240 }
  const props = { anchorRef, listRef, contentHeightRef }
  render(Harness, props)
  return props
}

function commit(listRef, frame) {
  listRef.current.style.left = `${String(frame.left)}px`
  listRef.current.style.top = `${String(frame.top)}px`
  listRef.current.rect = {
    left: frame.left, top: frame.top,
    right: frame.left + frame.width, bottom: frame.top + frame.maxHeight, width: frame.width,
  }
}

function expectedBox(anchor, desiredWidth) {
  return placementOf({
    anchor, bounds: VIEW_RECT, contentHeight: 240, desiredWidth,
    gap: POPOVER_GAP, margin: POPOVER_MARGIN, maxHeight: POPOVER_MAX_HEIGHT, minHeight: POPOVER_MIN_HEIGHT,
  })
}

const ANCHOR = { left: 20, top: 100, right: 271, bottom: 142, width: 251 }

test('scroll 后连续 place：跟随当前锚点，不累加待提交坐标', () => {
  const anchorRef = { current: anchorNode(ANCHOR) }
  const listRef = { current: contentNode() }
  const props = mount(anchorRef, listRef)

  captured.place()
  rerender(Harness, props)
  const first = expectedBox(ANCHOR, ANCHOR.width)
  assert.equal(captured.frame.top, Math.round(first.top), '首帧按当前锚点排布')
  commit(listRef, captured.frame)

  // 滚动：锚点下移，但 DOM 里仍是上一帧的 inline 坐标。
  const scrolled = { left: 20, top: 281.1875, right: 271, bottom: 323.1875, width: 251 }
  anchorRef.current = anchorNode(scrolled)
  captured.place()
  captured.place()
  rerender(Harness, props)

  const want = expectedBox(scrolled, scrolled.width)
  assert.equal(captured.frame.top, Math.round(want.top),
    '待提交的旧目标不能被当成 containing-block 偏移（旧实现会累加到 512）')
  assert.equal(captured.frame.left, Math.round(want.left))
})

test('transformed containing block：按实际 inline 与自身 rect 的差补偿且幂等', () => {
  const anchorRef = { current: anchorNode(ANCHOR) }
  const listRef = { current: contentNode() }
  const props = mount(anchorRef, listRef)

  captured.place()
  rerender(Harness, props)
  const box = expectedBox(ANCHOR, ANCHOR.width)

  // 祖先有 transform：实际渲染比 fixed 坐标偏移 (40, 25)。
  listRef.current.style.left = `${String(Math.round(box.left))}px`
  listRef.current.style.top = `${String(Math.round(box.top))}px`
  listRef.current.rect = {
    left: Math.round(box.left) - 40, top: Math.round(box.top) - 25,
    right: Math.round(box.left) - 40 + box.width, bottom: Math.round(box.top) - 25 + box.maxHeight, width: box.width,
  }

  captured.place()
  rerender(Harness, props)
  assert.equal(captured.frame.left, Math.round(box.left) + 40, '横向要补偿 containing-block 偏移')
  assert.equal(captured.frame.top, Math.round(box.top) + 25, '纵向要补偿 containing-block 偏移')

  captured.place()
  rerender(Harness, props)
  assert.equal(captured.frame.left, Math.round(box.left) + 40, '重复 place 幂等，不累加')
  assert.equal(captured.frame.top, Math.round(box.top) + 25, '重复 place 幂等，不累加')
})

test('没有实际 inline 坐标时不发明偏移', () => {
  const anchorRef = { current: anchorNode(ANCHOR) }
  const listRef = { current: contentNode() }
  const props = mount(anchorRef, listRef)
  captured.place()
  rerender(Harness, props)
  const want = expectedBox(ANCHOR, ANCHOR.width)
  assert.equal(captured.frame.top, Math.round(want.top), '首帧无 inline 时偏移为 0')
  assert.equal(captured.frame.left, Math.round(want.left))
})
