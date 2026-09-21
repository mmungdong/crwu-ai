import * as React from 'react'
import { Badge, Button, Card } from '../../components/primitives.tsx'
import { WORKBENCH_CLASSES as C } from '../workbench/consts.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { workbenchApi } from '../report-audit/api.ts'

/**
 * ⑥ OSS 授权（AccessKey）。
 *
 * **Host 侧早就实现了 `oss-cred-save`，但界面上一直没有入口** —— 没有入口的操作等于不存在：
 * 用户只能靠安装提示词让 agent 去配，而在「审核已经跑完、就等着上传」的时候再去找 agent
 * 是来不及的。所以这个表单是必要的，不是锦上添花。
 *
 * 三条凭据处理约束（与 Host 一致，这里只做展示层配合）：
 * 1. **密钥不回显**：Secret 是 `type=password`，提交成功后立刻清空 state；
 * 2. **只展示掩码**：AK ID 由 Host 掩码后返回（`AKID****7890`），页面不做二次处理；
 * 3. **保存即实测**：Host 写完文件会立刻用这套 AK 列一次对象，界面把实测结果如实显示 ——
 *    「写进文件了」不等于「AK 能用」。
 */

export interface OssAuthCardProps {
  /** Host 返回的**脱敏**视图。 */
  cred: {
    path: string
    exists: boolean
    endpoint: string
    accessKeyIdMasked: string
    hasSecret: boolean
    hasSts: boolean
    language: string
  } | null
  onRefresh: () => void
}

interface SavedState {
  busy: boolean
  message: string
  ok: boolean
}

export function OssAuthCard(props: OssAuthCardProps): React.ReactElement {
  const [akId, setAkId] = React.useState('')
  const [akSecret, setAkSecret] = React.useState('')
  const [saved, setSaved] = React.useState<SavedState>({ busy: false, message: '', ok: false })

  const save = (): void => {
    if (akId.trim() === '' || akSecret.trim() === '') {
      setSaved({ busy: false, message: zhCN.ossCredNeedBoth, ok: false })
      return
    }
    setSaved({ busy: true, message: '', ok: false })
    workbenchApi.ossCredSave({
      accessKeyId: akId.trim(),
      accessKeySecret: akSecret.trim(),
    })
      .then((result) => {
        if (result.ok !== true) {
          setSaved({ busy: false, message: `${zhCN.ossCredSaveFailed}${String(result.error ?? '')}`, ok: false })
          return
        }
        // 提交成功立刻清空密钥：它们已经写进文件了，留在 React state 里没有理由。
        setAkSecret('')
        const probe = (result.probe ?? {}) as { ok?: boolean; state?: string; detail?: string }
        const detail = probe.ok === true
          ? `${zhCN.ossCredProbeOk}${String(probe.state ?? '')}`
          : `${zhCN.ossCredProbeFailed}${String(probe.detail ?? '').slice(0, 300)}`
        setSaved({
          busy: false,
          ok: probe.ok === true,
          message: `${zhCN.ossCredSaved}${String(result.path ?? '')}${zhCN.ossCredPerm}${detail}`,
        })
        props.onRefresh()
      })
      .catch((cause: unknown) => {
        setSaved({
          busy: false,
          ok: false,
          message: `${zhCN.ossCredSaveFailed}${cause instanceof Error ? cause.message : String(cause)}`,
        })
      })
  }

  const cred = props.cred
  const configured = cred !== null && cred.exists

  return <Card
    title={zhCN.ossCredTitle}
    extra={configured ? <Badge text={zhCN.ossCredWritten} tone="ok" /> : <Badge text={zhCN.ossCredMissing} tone="high" />}
  >
    <div className={C.muted}>
      {`${zhCN.ossCredIntro}${cred?.path ?? '~/.ossutilconfig'}${zhCN.ossCredIntroTail}`}
    </div>

    {configured
      ? <div className={C.row} style={{ margin: '8px 0' }}>
          <span className={`${C.badge} ${C.badgeLow} ${C.mono}`}>{`AK ID · ${cred.accessKeyIdMasked === '' ? zhCN.ossCredEmpty : cred.accessKeyIdMasked}`}</span>
          <span className={`${C.badge} ${cred.hasSecret ? C.badgeOk : C.badgeHigh} ${C.mono}`}>
            {`Secret · ${cred.hasSecret ? zhCN.ossCredConfigured : zhCN.ossCredAbsent}`}
          </span>
        </div>
      : null}

    <div className={C.kv}>
      <label className={C.kvKey} htmlFor="crwu-ak-id">AccessKey ID</label>
      <input
        id="crwu-ak-id"
        className={`${C.input} ${C.mono}`}
        type="text"
        value={akId}
        placeholder="LTAI..."
        onChange={(event) => setAkId(readValue(event))}
      />
      <label className={C.kvKey} htmlFor="crwu-ak-secret">AccessKey Secret</label>
      <input
        id="crwu-ak-secret"
        className={`${C.input} ${C.mono}`}
        type="password"
        value={akSecret}
        placeholder={zhCN.ossCredSecretPlaceholder}
        onChange={(event) => setAkSecret(readValue(event))}
      />
    </div>

    <div className={C.row} style={{ marginTop: '10px' }}>
      <Button
        label={saved.busy ? zhCN.ossCredSaving : zhCN.ossCredSave}
        tone="primary"
        disabled={saved.busy}
        onClick={save}
      />
      <Button label={zhCN.refreshEnv} disabled={saved.busy} onClick={props.onRefresh} />
    </div>

    {saved.message === '' ? null : <div className={saved.ok ? C.muted : C.error}>{saved.message}</div>}
  </Card>
}

/** 从 input 事件里取值；不依赖 DOM 类型（测试里是替身）。 */
function readValue(event: unknown): string {
  const target = (event as { target?: { value?: unknown } } | null)?.target
  return target === undefined || target === null ? '' : String(target.value ?? '')
}
