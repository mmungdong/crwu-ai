import * as React from 'react'
import { Button, Chip, Notice } from '../../components/primitives.tsx'
import { WORKBENCH_CLASSES as C } from '../workbench/consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { workbenchApi, type EnvResult } from '../report-audit/api.ts'
import { credentialPermissionHint } from './credential-permission.ts'

/**
 * 阿里云 OSS 交付凭据（步骤 2）。
 *
 * ## 与 iFinD 同一套口径
 *
 * **员工自己填、密钥不回显、保存后立刻真实验证**（宿主会用包内 `ossutil` 对配置好的
 * bucket + 业务前缀做一次只读列举）。区别有两点：
 *
 * 1. AK 是两个字段（ID + Secret），各自有真实 `<label>`、纵向排布（窄窗口里不会挤成一行）；
 * 2. **Bucket / Endpoint / 前缀由部署配置决定**，员工只填凭据 —— 插件不接受员工自填 Bucket
 *    （那等于让员工把交付件传到任意桶）。所以这三个值只在开发者诊断里显示。
 *
 * ## 失败按四类给人话
 *
 * `credential`（AK 无效 → 重填）/ `permission`（没有交付目录权限 → 找管理员）/
 * `config`（Bucket 或 Endpoint 配错 → 找管理员）/ `infrastructure`（网络超时 → 稍后重试）。
 * 把"网络不通"说成"AK 填错"会让人反复换一份好密钥。
 */

export interface OssCredCardProps {
  delivery: EnvResult['delivery']
  /** 保存并验证通过后刷新环境自检。 */
  onSaved: () => void
}

/** 失败归因 → 员工该做什么（四类文案互不相同）。 */
export function ossErrorHint(errorKind: string): string {
  if (errorKind === 'credential') return zhCN.envOssErrCredential
  if (errorKind === 'permission') return zhCN.envOssErrPermission
  if (errorKind === 'config') return zhCN.envOssErrConfig
  if (errorKind === 'infrastructure') return zhCN.envOssErrInfrastructure
  return ''
}

export function OssCredCard(props: OssCredCardProps): React.ReactElement {
  const cred = props.delivery.ossCred
  const probe = props.delivery.probe
  const configured = props.delivery.oss.bucket !== ''
  const saved = cred.exists && cred.hasSecret
  const verified = probe.ok === true
  const [accessKeyId, setAccessKeyId] = React.useState('')
  const [accessKeySecret, setAccessKeySecret] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [hint, setHint] = React.useState('')
  const [message, setMessage] = React.useState('')
  const [replacing, setReplacing] = React.useState(false)
  const mounted = React.useRef(true)
  React.useEffect(() => () => { mounted.current = false }, [])

  const showInput = !saved || replacing

  const save = (): void => {
    const keyId = accessKeyId.trim()
    const secret = accessKeySecret.trim()
    // 提交的**那一瞬间**就丢掉本地这两份：Client 不保留已保存的密钥。
    setAccessKeyId('')
    setAccessKeySecret('')
    setBusy(true)
    setError('')
    setHint('')
    setMessage('')
    void workbenchApi.ossCredSave({ accessKeyId: keyId, accessKeySecret: secret })
      .then((result) => {
        if (!mounted.current) return
        const outcome = result.probe as { ok?: boolean; state?: string; detail?: string; errorKind?: string } | undefined
        // 宿主把"凭据已保存但真实验证没过"也回成 `ok: false`（错误文案就是探测详情），
        // 所以失败分支必须把**归因**一起翻出来 —— 网络不通与 AK 填错的动作完全不同。
        if (result.ok !== true) {
          setError(String(result.error ?? outcome?.detail ?? zhCN.envOssNotReady))
          setHint(ossErrorHint(String(outcome?.errorKind ?? result.errorKind ?? '')))
          // 只叠「真的没收紧成功」这种硬问题；ACL 说明会把连通性归因挤掉。
          const failed = credentialPermissionHint(result.permission, { onlyFailures: true })
          if (failed !== '') setHint(failed)
          return
        }
        setReplacing(false)
        const permissionHint = credentialPermissionHint(result.permission)
        if (permissionHint !== '') setHint(permissionHint)
        if (outcome?.ok === true) {
          setMessage(zhCN.envOssSaved)
          props.onSaved()
          return
        }
        setError(String(outcome?.detail ?? outcome?.state ?? zhCN.envOssNotReady))
        setHint(ossErrorHint(String(outcome?.errorKind ?? '')))
      })
      .catch((cause: unknown) => {
        if (mounted.current) {
          setError(cause instanceof Error ? cause.message : String(cause))
          setHint(zhCN.envOssErrInfrastructure)
        }
      })
      .finally(() => { if (mounted.current) setBusy(false) })
  }

  /**
   * 「重新验证」：用**已保存**的凭据再打一次真实请求。
   *
   * 复用 `oss-cred-save` 是不可行的（那要再传一次密钥，而 Client 手里没有）。
   * 所以这里让宿主走环境自检的 `refresh` 路径：它会重新跑一次 `ossutil ls`，
   * 而不是复用上一次的结论。
   */
  const verify = (): void => {
    setBusy(true)
    setError('')
    setHint('')
    setMessage('')
    void workbenchApi.env({ refresh: true })
      .then(() => {
        if (!mounted.current) return
        props.onSaved()
      })
      .catch((cause: unknown) => {
        if (mounted.current) {
          setError(cause instanceof Error ? cause.message : String(cause))
          setHint(zhCN.envOssErrInfrastructure)
        }
      })
      .finally(() => { if (mounted.current) setBusy(false) })
  }

  return <div className={C.stepCard} data-crwu-oss-card="1">
    <div className={C.stepHead}>
      <span className={C.itemName}>{zhCN.envOssCardTitle}</span>
      <Chip
        text={verified ? zhCN.envOssReady : (saved ? zhCN.envItemMissing : zhCN.envIfindStateUnconfigured)}
        tone={verified ? 'ok' : (saved ? 'busy' : 'bad')}
      />
    </div>
    <p className={C.stepLead}>{zhCN.envOssCardHint}</p>
    {configured ? null : <Notice tone="warn">{zhCN.envOssNeedAdmin}</Notice>}

    {/* 已保存时只给**掩码**（AK ID 本身是半公开的，Secret 从不回显）。 */}
    {saved
      ? <div className={`${C.itemMeta} ${C.mono}`}>
          {`${zhCN.envOssCredAk} ${cred.accessKeyIdMasked || zhCN.envOssSavedSummary}`}
        </div>
      : null}
    {verified ? null : (probe.state === '' ? null : <div className={C.itemFix}>{probe.detail || probe.state}</div>)}
    {probe.errorKind === undefined || probe.errorKind === '' || probe.ok === true
      ? null
      : <div className={C.itemFix}>{ossErrorHint(probe.errorKind)}</div>}

    {showInput
      ? <div className={C.stepFields}>
          <label className={C.field}>
            <span className={C.fieldLabel}>{zhCN.envOssAkLabel}</span>
            <input
              className={C.input}
              type="text"
              name="crwu-oss-ak"
              autoComplete="off"
              spellCheck={false}
              value={accessKeyId}
              disabled={busy}
              onChange={(event) => { setAccessKeyId(event.target.value) }}
            />
          </label>
          <label className={C.field}>
            <span className={C.fieldLabel}>{zhCN.envOssSkLabel}</span>
            <input
              className={C.input}
              type="password"
              name="crwu-oss-sk"
              autoComplete="off"
              spellCheck={false}
              value={accessKeySecret}
              disabled={busy}
              onChange={(event) => { setAccessKeySecret(event.target.value) }}
            />
          </label>
        </div>
      : null}

    <div className={C.row}>
      {showInput
        ? <Button
            label={busy ? zhCN.envOssSubmitting : zhCN.envOssSubmit}
            tone="primary"
            disabled={busy || accessKeyId.trim() === '' || accessKeySecret.trim() === ''}
            onClick={save}
          />
        : <>
            <Button label={busy ? zhCN.envOssSubmitting : zhCN.envOssRetry} small disabled={busy} onClick={verify} />
            <Button label={zhCN.envOssReplace} small disabled={busy} onClick={() => { setReplacing(true) }} />
          </>}
      {replacing && saved
        ? <Button label={zhCN.envCancel} small disabled={busy} onClick={() => { setAccessKeyId(''); setAccessKeySecret(''); setReplacing(false) }} />
        : null}
    </div>

    {error === '' ? null : <Notice tone="warn">{error}</Notice>}
    {hint === '' ? null : <div className={C.itemFix}>{hint}</div>}
    {message === '' ? null : <Notice tone="ok">{message}</Notice>}
    <div className={C.muted}>{zhCN.envOssNeverAsk}</div>
    <div className={C.muted}>{zhCN.envOssNeedAdmin}</div>
  </div>
}
