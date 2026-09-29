import type { DwsLocalDoctorView, DwsLocalRepairView } from '../../../shared/types.ts'
import { zhCN } from '../../locales/zh-CN.ts'
import { Button, Chip } from '../../components/primitives.tsx'
import { WORKBENCH_CLASSES as C } from '../workbench/consts.ts'

/**
 * 「钉钉本机目录」体检与最小权限修复（协议 18 · 子项目 D）。
 *
 * ## 为什么按钮是**条件渲染**的
 *
 * 设计 §D3 明确列出：沙箱拒绝、沙箱降级、凭据存储被拒、认证失败、所有者不对、文件锁 ——
 * 这些情形下**不渲染**修复按钮。理由不是"藏起来好看"，而是这几类问题改文件权限**解决不了**，
 * 渲染一个按下去必然失败（或被服务端拒绝）的按钮，只会让员工以为是权限问题、反复点。
 * 服务端仍然自己判一次（客户端可以伪造请求），界面这一层只是不给假希望。
 *
 * ## 为什么修复要**二次确认**
 *
 * 它写的是员工机器上的目录权限。第一次确认（本机访问授权）说的是"允许读本机账号和配置"，
 * 不等于"允许改我的目录权限" —— 两件事必须分开问。
 */

/** 修复按钮的渲染条件：**只有**确诊"本机文件权限问题"才出现。 */
export function repairOffered(doctor: DwsLocalDoctorView | null): boolean {
  if (doctor === null || !doctor.ok) return false
  return doctor.classification === 'os-filesystem-permission'
}

/**
 * 员工能看懂的一句话结论（技术细节留给开发者诊断）。
 *
 * **顺序就是优先级**：先报"员工必须先处理、且与可写性无关"的那几类（所有者不对、锁被占用、
 * 钥匙串被拒），最后才轮到"目录可写"这个好消息。
 * 反过来的话，"锁被占用 + 目录恰好可写"会被说成「可读写，正常」—— 那是把真问题盖掉
 * （2026-09-29 由 `client-dws-local.test.mjs` 的排序用例抓到）。
 */
export function dwsLocalSummary(doctor: DwsLocalDoctorView): string {
  if (!doctor.ok) return doctor.error === '' ? zhCN.dwsLocalCheckFailed : doctor.error
  if (!doctor.directoryExists) return zhCN.dwsLocalNoDirectory
  if (doctor.ownerMatchesCurrentUser === false) return zhCN.dwsLocalWrongOwner
  if (doctor.classification === 'file-lock') return zhCN.dwsLocalLocked
  if (doctor.credentialStoreState === 'interaction-denied' || doctor.credentialStoreState === 'access-denied') {
    return zhCN.dwsLocalKeychain
  }
  // 目录**可写**是好消息，优先于"还没登录"：登录态由上面「钉钉认证」那一行负责说，
  // 这张卡只说目录本身。反过来的话，一台目录完全正常的机器会一直显示「还没有登录」。
  // 锁文件**自己**不可写要在"目录正常"之前说：原始报错就是 `opening lock file ... Access is denied`，
  // 这时说「可读写，正常」会让员工以为没有问题（而修复入口又出现了）。
  if (doctor.lockWritable === false) return zhCN.dwsLocalLockNotWritable
  if (doctor.currentUserCanModify === true) return zhCN.dwsLocalWritable
  if (doctor.currentUserCanModify === false) return zhCN.dwsLocalNotWritable
  if (doctor.credentialStoreState === 'missing-secret') return zhCN.dwsLocalNotLoggedIn
  return zhCN.dwsLocalUnknown
}

/** 修复结果的员工口径。 */
export function repairSummary(result: DwsLocalRepairView): string {
  if (!result.ok) return result.error
  const done = result.repaired.length
  const skipped = result.skipped.length === 0 ? '' : `（${result.skipped.length} 项没做成）`
  return `${zhCN.dwsLocalRepaired}${String(done)}${skipped}`
}

export interface DwsLocalCardProps {
  doctor: DwsLocalDoctorView | null
  repair: DwsLocalRepairView | null
  busy: boolean
  /** 二次确认面板是否展开。 */
  confirming: boolean
  error: string
  /**
   * Host 给的"现在能不能体检"（`undefined` = 还没问到）。
   *
   * 为什么不让客户端自己判断：客户端看不到诊断里的结构化事实（例如 `lockRelated`），
   * 猜出来的一定与 Host 不一致 —— 于是要么"按钮亮着、点下去被拒"，要么"灰着、其实能体检"。
   */
  canDiagnose?: boolean
  onCheck: () => void
  onAskRepair: () => void
  onCancelRepair: () => void
  onConfirmRepair: () => void
}

export function DwsLocalCard(props: DwsLocalCardProps): React.ReactElement {
  const { doctor } = props
  const offered = repairOffered(doctor)
  return <div className={C.item} data-crwu-dws-local="1">
    <div className={C.itemHead}>
      <span className={C.itemName}>{zhCN.dwsLocalTitle}</span>
      <Chip text={doctor === null ? zhCN.dwsLocalUnchecked : dwsLocalSummary(doctor)} tone={doctor === null ? 'idle' : (offered ? 'bad' : 'ok')} />
    </div>
    {props.error === '' ? null : <div className={C.itemFix}>{props.error}</div>}
    {/* 体检**不是随时可跑的健康检查**（设计 §D2）：它只回答"刚才那次为什么失败"。
        这句话放在按钮旁边，员工才不会以为按钮坏了。 */}
    {doctor === null && props.error === ''
      ? (
        <div
          className={C.itemNote}
          data-crwu-dws-local-note="1"
          data-crwu-dws-local-disabled={props.canDiagnose === false ? '1' : '0'}
        >{zhCN.dwsLocalNeedsFailure}</div>
      )
      : null}
    <div className={C.layerActions}>
      {/* 能不能体检由 **Host** 说了算（`dwsDiagnosable`）：`false` 直接禁用，
          不让员工点一个必然被拒的按钮。`undefined` = 还没问到 → 保持可点（Host 仍会拒绝）。 */}
      <Button
        label={zhCN.dwsLocalCheck}
        small
        disabled={props.busy || props.canDiagnose === false}
        onClick={props.onCheck}
      />
      {/* 条件渲染：只有"本机文件权限问题"才有这个按钮。 */}
      {offered && !props.confirming
        ? <Button label={zhCN.dwsLocalRepair} small disabled={props.busy} onClick={props.onAskRepair} />
        : null}
    </div>
    {offered && props.confirming
      ? <div className={C.itemFix}>
        <div>{zhCN.dwsLocalRepairConfirm}</div>
        <div className={C.layerActions}>
          <Button label={zhCN.dwsLocalRepairConfirmYes} small disabled={props.busy} onClick={props.onConfirmRepair} />
          <Button label={zhCN.dwsLocalRepairConfirmNo} small disabled={props.busy} onClick={props.onCancelRepair} />
        </div>
      </div>
      : null}
    {props.repair === null ? null : <div className={C.itemFix}>{repairSummary(props.repair)}</div>}
  </div>
}
