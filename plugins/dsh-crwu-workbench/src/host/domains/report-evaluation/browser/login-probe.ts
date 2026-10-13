import { text } from '../../../../shared/utils/value.ts'
import type { LoginState } from './login-state.ts'

/**
 * `LoginState` 在**外部案例来源**上的确切含义。
 *
 * 这三个字读起来像"插件知道你的账号有没有登录"，而事实是：插件**不读 Cookie、不碰凭据**，
 * 所以它无法知道账号状态。这里回答的是另一个问题 —— **站点是否放行公开检索**：
 *
 * | 状态 | 含义 | 用户能做什么 |
 * | --- | --- | --- |
 * | `authenticated` | 公开检索页正常返回，能看到结果结构 | 什么都不用做 |
 * | `unauthenticated` | 被登录墙 / 访问限制挡住 | 用默认浏览器登录该站，再点「重新检查」 |
 * | `unknown` | 网络不可达、超时、要求验证码 | 看详情：换网络 / 人工过验证码 |
 *
 * 把它写成显式表而不是含糊的"登录检查"，是因为含糊会直接导致两种错误做法：
 * 一是拿状态当凭据事实去"修账号"，二是被验证码挡住时说成"你没登录"。
 */

/** 判定用的特征串（命中任一即认为页面要求人工介入）。 */
const LOGIN_WALL_PATTERNS = [
  /请先登录/, /登录后查看/, /立即登录/, /用户登录/, /passport\./i,
  /sign\s*in\s*to\s*continue/i, /please\s+log\s*in/i, /登录可见/,
]

const CAPTCHA_PATTERNS = [
  /验证码/, /滑动验证/, /安全验证/, /人机验证/, /captcha/i, /geetest/i, /verify\s*you\s*are\s*human/i,
]

/** 页面看起来要求登录（登录墙）。 */
export function looksLikeLoginWall(body: unknown): boolean {
  const html = text(body)
  if (html === '') return false
  return LOGIN_WALL_PATTERNS.some((pattern) => pattern.test(html))
}

/** 页面看起来要求验证码 / 人机校验。 */
export function looksLikeCaptcha(body: unknown): boolean {
  const html = text(body)
  if (html === '') return false
  return CAPTCHA_PATTERNS.some((pattern) => pattern.test(html))
}

export interface ProbeFacts {
  ok: boolean
  status: number
  body: string
  error?: string
}

export interface ProbeVerdict {
  state: LoginState
  detail: string
  /** 需要人工在浏览器完成验证（插件**不**做任何绕过）。 */
  captcha: boolean
}

/**
 * 由一次探测的事实推出状态。
 *
 * 顺序即优先级：**网络失败 > 验证码 > 登录墙 > 状态码 > 正常**。
 * 网络失败放最前，是因为"连不上"与"被挡住"对用户是两件完全不同的事
 * （换网络 vs 去登录），而连不上时页面里那些特征串本来就不可信。
 */
export function classifyProbe(facts: ProbeFacts): ProbeVerdict {
  if (!facts.ok) {
    return { state: 'unknown', detail: `无法访问该来源：${text(facts.error) || '网络不可达或超时'}`, captcha: false }
  }
  if (looksLikeCaptcha(facts.body)) {
    return {
      state: 'unknown',
      detail: '该来源要求验证码 / 人机校验：请在默认浏览器打开该站点并人工完成，然后点「重新检查」。插件不会绕过验证。',
      captcha: true,
    }
  }
  if (looksLikeLoginWall(facts.body)) {
    return { state: 'unauthenticated', detail: '该来源提示需要登录后才能检索：请在默认浏览器登录后点「重新检查」。', captcha: false }
  }
  if (facts.status >= 400 || facts.status === 0) {
    return {
      state: 'unknown',
      detail: facts.status === 0 ? '没有拿到 HTTP 状态码：无法判断站点是否放行公开检索。' : `该来源返回 HTTP ${facts.status}。`,
      captcha: false,
    }
  }
  return { state: 'authenticated', detail: '公开检索页正常返回。', captcha: false }
}
