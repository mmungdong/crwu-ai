/**
 * 极验 v3（Geetest）**可见挑战**探针 —— 固定脚本，随 Go binary embed。
 *
 * ## 为什么这是一个固定脚本而不是"给模型一个 eval 口子"
 *
 * 2026-10-14 的要求是「检测到人机验证要先调用沉淀下来的固定脚本尝试恢复」。
 * 满足它的方式**不是**给 Agent 一个 `--eval`（那等于把任意 JS 执行权交出去），
 * 而是把唯一需要的页面读取写成这一份**不可参数化**的脚本：它对每个页面做同一组只读查询，
 * 返回值只是一些几何与像素事实。Go 侧的 CDP 只调用 `Runtime.evaluate(这个常量)`，
 * 从不拼接调用方输入的表达式。
 *
 * ## 它只认"看得见的挑战"
 *
 * 归档证据（`dsh-session-session-cdp-skip-...`，事件 414–415）显示：该来源的业务内容可读时，
 * HTML 里**仍然**含有 captcha 字样。也就是说"页面源码里出现验证码"不能当作遇到验证码 ——
 * 那样会把每一张正常页都送去解滑块。所以这里的判据是几何可见性 + 命中测试：
 * 覆盖层必须真的有尺寸、真的可见、而且真的挡在鼠标路径上。
 *
 * ## 输出形状（JSON 字符串）
 *
 * `{ present, family, tainted, inIframe, href, title, overlay, sliderButton, track,
 *    canvases: [{ selector, box, intrinsic, png }], successVisible, failVisible,
 *    bodyHas: { slider, successText, failText } }`
 *
 * `box` 是 **CSS 像素**（`getBoundingClientRect`），`intrinsic` 是 canvas 的本征像素
 * （`canvas.width/height`）。两者之比就是 CSS 缩放：缺口偏移在本征像素里算出来之后必须
 * 乘这个比例才能拿去 `Input.dispatchMouseEvent`。归档脚本没有处理这一点（它拿到的
 * 是同一台机器、`deviceScaleFactor=1` 的巧合），这里显式给出两个尺寸。
 *
 * 任何异常都退化成 `present:false` + `error`，绝不抛出去让整条命令变成"基础设施故障"。
 */
(function () {
  var MIN_W = 20
  var MIN_H = 10

  function boxOf(el) {
    var r = el.getBoundingClientRect()
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]
  }

  function styleAllows(el) {
    var s = window.getComputedStyle(el)
    if (!s) return true
    if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false
    if (parseFloat(s.opacity || '1') < 0.1) return false
    if (s.pointerEvents === 'none') return false
    return true
  }

  // A challenge is only "visible" when it occupies real space, is not clipped away,
  // and actually receives the pointer at its own centre. The hit test is what
  // separates a live overlay from leftover markup for a dismissed one.
  function visible(el) {
    if (!el || el.nodeType !== 1) return false
    var r = el.getBoundingClientRect()
    if (r.width < MIN_W || r.height < MIN_H) return false
    if (r.bottom <= 0 || r.right <= 0) return false
    if (r.top > window.innerHeight * 4) return false
    if (!styleAllows(el)) return false
    return true
  }

  function hitTest(el) {
    if (!el || typeof document.elementFromPoint !== 'function') return false
    var r = el.getBoundingClientRect()
    var x = Math.round(r.left + r.width / 2)
    var y = Math.round(r.top + r.height / 2)
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false
    var top = document.elementFromPoint(x, y)
    if (!top) return false
    return top === el || el.contains(top) || top.contains(el)
  }

  function firstVisible(selectors) {
    for (var i = 0; i < selectors.length; i += 1) {
      var nodes = document.querySelectorAll(selectors[i])
      for (var j = 0; j < nodes.length; j += 1) {
        if (visible(nodes[j])) {
          return { selector: selectors[i], box: boxOf(nodes[j]), hit: hitTest(nodes[j]) }
        }
      }
    }
    return null
  }

  function collectCanvases(root) {
    var out = []
    var nodes = (root || document).querySelectorAll('canvas')
    for (var i = 0; i < nodes.length; i += 1) {
      var canvas = nodes[i]
      if (!visible(canvas)) continue
      var png = null
      var tainted = false
      try {
        png = canvas.toDataURL('image/png')
      } catch (error) {
        // A cross-origin background image taints the canvas. That is a definite
        // "we cannot read the pixels", not an empty challenge.
        tainted = true
        png = null
      }
      out.push({
        selector: 'canvas',
        className: String(canvas.className || ''),
        box: boxOf(canvas),
        intrinsic: { w: canvas.width, h: canvas.height },
        tainted: tainted,
        png: png,
      })
      if (out.length >= 8) break
    }
    return out
  }

  var payload = {
    present: false,
    family: '',
    tainted: false,
    inIframe: false,
    href: '',
    title: '',
    overlay: null,
    sliderButton: null,
    track: null,
    canvases: [],
    successVisible: false,
    failVisible: false,
    bodyHas: { slider: false, successText: false, failText: false },
    error: '',
  }

  try {
    payload.href = String(location.href)
    payload.title = String(document.title || '')

    var body = document.body
    var text = body ? String(body.innerText || '') : ''
    payload.bodyHas.slider = /拖动滑块|按住滑块|向右滑动/.test(text)
    payload.bodyHas.successText = /验证成功|通过验证/.test(text)
    payload.bodyHas.failText = /验证失败|再来一次|重试/.test(text)

    var slider = firstVisible([
      '.geetest_slider_button',
      '.geetest_btn',
      '[class*="slider_button"]',
      '.geetest_radar_tip',
    ])
    var track = firstVisible(['.geetest_slider', '.geetest_slider_track', '[class*="slider_track"]'])
    var overlay = firstVisible([
      '.geetest_panel',
      '.geetest_wind',
      '.geetest_box',
      '[class*="geetest_panel"]',
      '[class*="geetest_wind"]',
    ])
    var success = firstVisible(['.geetest_success_radar_tip', '.geetest_panel_success', '[class*="success_radar"]'])

    payload.sliderButton = slider
    payload.track = track
    payload.overlay = overlay
    payload.successVisible = success !== null
    payload.failVisible = payload.bodyHas.failText

    // Same-origin iframes are inspected too: some deployments mount the widget in
    // one. A cross-origin frame is unreachable, and that is reported as
    // `inIframe` so the caller can answer `unsupported` rather than guessing.
    var canvases = collectCanvases(document)
    var frames = document.querySelectorAll('iframe')
    for (var f = 0; f < frames.length && canvases.length === 0; f += 1) {
      var frame = frames[f]
      if (!visible(frame)) continue
      try {
        var doc = frame.contentDocument
        if (doc === null || doc === undefined) {
          payload.inIframe = true
          continue
        }
        canvases = canvases.concat(collectCanvases(doc))
      } catch (error) {
        payload.inIframe = true
      }
    }
    payload.canvases = canvases
    for (var c = 0; c < canvases.length; c += 1) {
      if (canvases[c].tainted) payload.tainted = true
    }

    // `present` means "a challenge a human would have to touch is on screen". A
    // success badge counts as *no* challenge (nothing left to solve).
    var hasControl = slider !== null || track !== null
    var hasCanvas = canvases.length > 0
    payload.present = (overlay !== null && (hasControl || hasCanvas)) || (hasControl && hasCanvas)
    if (payload.present) {
      payload.family = hasCanvas ? 'geetest-v3-canvas' : 'geetest-v3-dom'
    }
  } catch (error) {
    payload.present = false
    payload.error = String((error && error.message) || error)
  }

  return JSON.stringify(payload)
})()
