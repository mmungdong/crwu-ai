import * as React from 'react'
import { Button, Chip, Notice } from '../../components/primitives.tsx'
import { WORKBENCH_CLASSES as C } from '../workbench/consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { workbenchApi, type EnvResult, type IfindProbeResult, type IfindStatusResult } from '../report-audit/api.ts'

/**
 * ⑥ iFinD **API-Key** 卡片。
 *
 * ## 与"认证"分开的"能不能取数"
 *
 * 环境校验做的是**真实取数验证**：`initialize` → `tools/list` → **真的 `tools/call` 取一次数据**。
 * 两截结论分开显示，因为它们对员工意味着完全不同的动作：
 *
 * - **认证失败**（`credential`，401 / 签名错）→ 重填 API-Key；
 * - **权益受限**（`entitlement`，403 / 没有可安全试取的取数工具）→ 找管理员开通；
 * - **服务不可达**（`infrastructure`，网络 / 超时 / 协议）→ 稍后重试，**不是**你的 key 有问题；
 * - **认证通过但没取到数据**（`ok && !dataVerified`）→ 说清楚，绝不显示成「已认证」。
 *
 * ## 行为口径（每条都对应一条硬要求）
 *
 * 1. `type="password"` 输入；
 * 2. 保存过程中按钮禁用（一次保存 = 一次真实外部取数，可能几秒）；
 * 3. **Client 不保留已保存的 API-Key**：提交后立即清空输入框，且从不把已保存的值读回来
 *    （宿主只回长度）；
 * 4. 保存成功后立即真实验证（结论来自 Host 的探测）；
 * 5. 页面只显示「已认证」或安全的脱敏摘要（长度、工具数、取数摘要）；
 * 6. 允许替换 API-Key；
 * 7. 错误就地显示，且不回显 API-Key；
 * 8. 提供官方入口，但明说不要让 Agent 索取 / 代填。
 */

export interface IfindAuthCardProps {
  /** 环境自检里 iFinD 那一项（脱敏）。 */
  credential: EnvResult['external']
  /** 保存 / 重新验证成功（或状态变化）后刷新环境自检。 */
  onSaved: () => void
}

/** Host 回的状态 → 中文标签。**认不出的状态按未配置处理**（不假装已认证）。 */
export function ifindStateLabel(state: string): string {
  if (state === 'authenticated') return zhCN.envIfindStateAuthenticated
  if (state === 'unverified') return zhCN.envIfindStateUnverified
  if (state === 'invalid') return zhCN.envIfindStateInvalid
  if (state === 'unreachable') return zhCN.envIfindStateUnreachable
  return zhCN.envIfindStateUnconfigured
}

/**
 * 状态 → 色调（只有**真的取到数据**才是绿的）。
 *
 * 「已保存、没验过」与「认证过了但没取到数」都用 `busy`（琥珀）而不是 `bad`：
 * 它们不是故障，是"还没证据" —— 说成红色会让员工以为填错了，而去重填一份本来没问题的 key。
 */
export function ifindStateTone(state: string, dataVerified = false): 'ok' | 'busy' | 'bad' {
  if (dataVerified) return 'ok'
  if (state === 'authenticated' || state === 'unverified') return 'busy'
  return 'bad'
}

/**
 * 失败归类 → 员工该做什么。
 *
 * **三类必须分开**：把"服务不可达"说成"key 不对"会把人指去重新申请一份好密钥；
 * 把"权益不足"说成"key 不对"会让员工和管理员来回踢皮球。
 */
export function ifindErrorHint(errorKind: string): string {
  if (errorKind === 'credential') return zhCN.envIfindErrCredential
  if (errorKind === 'entitlement') return zhCN.envIfindErrEntitlement
  if (errorKind === 'infrastructure') return zhCN.envIfindErrInfrastructure
  return ''
}

/** 探测结论 → 给员工看的一行（成功只说"取到数据"，技术细节留给开发者诊断）。 */
export function probeLine(probe: IfindProbeResult): string {
  if (probe.dataVerified === true) {
    return zhCN.envIfindVerified
  }
  if (probe.ok) return zhCN.envIfindNoData
  return probe.error === '' ? ifindStateLabel(probe.state) : probe.error
}

/** 本地时刻；解析不出来就原样显示（不猜）。 */
function localTime(iso: string): string {
  if (iso === '') return ''
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? iso : new Date(parsed).toLocaleString()
}

export function IfindAuthCard(props: IfindAuthCardProps): React.ReactElement {
  const credential = props.credential
  const [apiKey, setApiKey] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [hint, setHint] = React.useState('')
  const [message, setMessage] = React.useState('')
  const [replacing, setReplacing] = React.useState(false)
  const [clearing, setClearing] = React.useState(false)
  const mounted = React.useRef(true)
  React.useEffect(() => () => { mounted.current = false }, [])

  /**
   * **环境结论换了就清掉上一次的界面结论**。
   *
   * 不做这一步会出现自相矛盾的画面：保存成功时留下的绿色「验证成功」提示会一直挂在卡片上，
   * 而后续一次真实探测可能已经变成 `invalid`（密钥被撤销 / 权益到期 / 被限流），
   * 于是同一张卡上同时出现「验证成功」与「API-Key 无效」两句话。
   * 只在**结论真的变了**时清（`credential` 是新对象，不能按引用比），
   * 否则用户点「保存并验证」刚拿到的结论会被紧随其后的自检刷掉。
   */
  const credentialKey = [
    credential.state, credential.errorKind, credential.ok === true ? '1' : '0',
    credential.dataVerified === true ? '1' : '0', credential.checkedAt, credential.reason,
  ].join('|')
  const lastKey = React.useRef(credentialKey)
  React.useEffect(() => {
    if (lastKey.current === credentialKey) return
    lastKey.current = credentialKey
    setMessage('')
    setError('')
    setHint('')
  }, [credentialKey])

  // 已保存时收起输入框（"允许替换"而不是"每次都逼你重填"）。
  const saved = credential.ok === true || credential.tokenLength > 0
  const showInput = !saved || replacing
  const tone = ifindStateTone(credential.state, credential.dataVerified === true)

  /** 把一次探测结论落到界面上（保存、重新验证两条出口共用）。 */
  const showProbe = (probe: IfindProbeResult): void => {
    setHint(ifindErrorHint(probe.errorKind))
    if (probe.dataVerified === true) {
      setError('')
      // 工具名与数据样本只在开发者诊断里出现（用户视图只要"成功/失败 + 时间"）。
      setMessage(zhCN.envIfindVerified)
      props.onSaved()
      return
    }
    setMessage('')
    setError(probe.ok ? zhCN.envIfindNoData : probe.error)
    if (probe.ok) setHint(zhCN.envIfindNoDataHint)
  }

  const save = (): void => {
    const value = apiKey
    // 提交成功后**立刻**丢掉本地这一份：Client 不保留已保存的 API-Key。
    setApiKey('')
    setBusy(true)
    setError('')
    setHint('')
    setMessage('')
    void workbenchApi.ifindCredentialSave({ secret: value })
      .then((result) => {
        if (!mounted.current) return
        if (!result.ok) {
          // 错误就地显示；**不回显**刚才那份 key。
          setError(result.error || zhCN.envIfindStateInvalid)
          setHint(ifindErrorHint(result.errorKind))
          return
        }
        setReplacing(false)
        // 权限没收紧要如实说（0600 是这份文件的安全边界）。
        if (result.chmodOk === false) setHint(result.chmodError)
        showProbe(result.probe)
      })
      .catch((cause: unknown) => {
        if (mounted.current) {
          setError(cause instanceof Error ? cause.message : String(cause))
          setHint(zhCN.envIfindErrInfrastructure)
        }
      })
      .finally(() => { if (mounted.current) setBusy(false) })
  }

  const verify = (): void => {
    setBusy(true)
    setError('')
    setHint('')
    setMessage('')
    void workbenchApi.ifindProbe({})
      .then((result) => {
        if (!mounted.current) return
        showProbe(result)
      })
      .catch((cause: unknown) => {
        if (mounted.current) {
          setError(cause instanceof Error ? cause.message : String(cause))
          setHint(zhCN.envIfindErrInfrastructure)
        }
      })
      .finally(() => { if (mounted.current) setBusy(false) })
  }

  const clear = (): void => {
    // 二次确认：这是不可撤销的（清掉之后要重新向管理员申请 / 回填）。
    const confirmed = typeof window === 'undefined' || window.confirm === undefined
      ? true
      : window.confirm(zhCN.envIfindClearConfirm)
    if (!confirmed) return
    setBusy(true)
    setClearing(true)
    setError('')
    setHint('')
    setMessage('')
    void workbenchApi.ifindCredentialClear({ confirm: true })
      .then((result) => {
        if (!mounted.current) return
        if (!result.ok) { setError(result.error); return }
        setMessage(zhCN.envIfindCleared)
        setReplacing(true)
        props.onSaved()
      })
      .catch((cause: unknown) => {
        if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (!mounted.current) return
        setBusy(false)
        setClearing(false)
      })
  }

  return <div className={C.item} data-crwu-ifind-card="1">
    <div className={C.itemMain}>
      <div className={C.itemHead}>
        <span className={C.itemName}>{zhCN.envIfindCardTitle}</span>
        <Chip text={ifindStateLabel(credential.state)} tone={tone} />
      </div>
      <div className={C.itemNote}>{zhCN.envIfindCardHint}</div>
      {/* 从哪里获得 + 怎么填：非程序员要能照着做完（不用去问 Agent）。 */}
      <div className={C.itemNote}>{zhCN.envIfindHowTo}</div>
      {/* 已保存时只给**脱敏摘要**（长度），永不显示 API-Key 本身。 */}
      {credential.tokenLength > 0
        ? <div className={`${C.itemMeta} ${C.mono}`}>
            {`${zhCN.ifindConfigured}${String(credential.tokenLength)}${zhCN.ifindNoEcho}`}
          </div>
        : null}
      {/* 真实取数验证：认证通过但没取到数据时必须**显式**说清，不能混进「已认证」。 */}
      {credential.ok === true && credential.dataVerified !== true
        ? <div className={C.itemFix}>{zhCN.envIfindNoData}</div>
        : null}
      {credential.dataVerified === true
        ? <div className={`${C.itemMeta} ${C.mono}`} data-crwu-ifind-verified-at={credential.checkedAt}>
            {`${zhCN.envIfindDataAt}${localTime(credential.checkedAt)}`}
          </div>
        : null}
      {credential.reason === '' ? null : <div className={C.itemFix}>{credential.reason}</div>}
      {credential.errorKind === '' ? null
        : <div className={C.itemFix}>{ifindErrorHint(credential.errorKind)}</div>}

      {showInput
        ? <div className={C.row}>
            <input
              className={C.input}
              type="password"
              name="crwu-ifind-apikey"
              autoComplete="off"
              spellCheck={false}
              aria-label={zhCN.envIfindSecretLabel}
              placeholder={zhCN.envIfindSecretPlaceholder}
              value={apiKey}
              disabled={busy}
              onChange={(event) => { setApiKey(event.target.value) }}
              onKeyDown={(event) => { if (event.key === 'Enter' && apiKey !== '' && !busy) save() }}
            />
            <Button
              label={busy ? zhCN.envIfindSubmitting : zhCN.envIfindSubmit}
              tone="primary"
              disabled={busy || apiKey === ''}
              onClick={save}
            />
            {replacing && saved
              ? <Button label={zhCN.envCancel} small disabled={busy} onClick={() => { setApiKey(''); setReplacing(false) }} />
              : null}
          </div>
        : <div className={C.row}>
            <Button label={zhCN.envIfindReplace} small disabled={busy} onClick={() => { setReplacing(true) }} />
            <Button label={busy && !clearing ? zhCN.envIfindSubmitting : zhCN.envIfindRetry} small disabled={busy} onClick={verify} />
            <Button label={zhCN.envIfindClear} small disabled={busy} onClick={clear} />
          </div>}

      {error === '' ? null : <Notice tone="warn">{error}</Notice>}
      {hint === '' ? null : <div className={C.itemFix}>{hint}</div>}
      {message === '' ? null : <Notice tone="ok">{message}</Notice>}
      <div className={C.muted}>{zhCN.envIfindNeverAsk}</div>
      <div className={C.row}>
        {credential.path === ''
          ? null
          : <span className={`${C.muted} ${C.mono}`}>{`${zhCN.envIfindPath} ${credential.path}`}</span>}
        <span className={C.grow} />
        {/* 官方入口：只给链接，**不代填、不索取** API-Key。 */}
        <a className={C.link} href={credential.applyUrl} target="_blank" rel="noreferrer noopener">{zhCN.envIfindGet}</a>
      </div>
      <div className={C.muted}>{zhCN.ifindSource}</div>
    </div>
  </div>
}

/** 供测试断言用的纯函数：把 `ifind-status` 的应答折算成界面状态。 */
export function ifindStatusOf(status: IfindStatusResult): { label: string; tone: 'ok' | 'busy' | 'bad' } {
  return {
    label: ifindStateLabel(status.state),
    tone: ifindStateTone(status.state, status.dataVerified === true),
  }
}
