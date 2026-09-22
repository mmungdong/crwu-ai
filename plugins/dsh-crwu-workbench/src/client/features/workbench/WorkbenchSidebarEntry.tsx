import * as React from 'react'
import { BrandMark } from '../../components/BrandMark.tsx'
import { AuditIcon, BadgeCheckIcon, BadgeWarnIcon, EnvIcon, EvalIcon, type IconProps } from '../../components/icons.tsx'
import { zhCN } from '../../locales/zh-CN.ts'
import { envLampOf, useEnvStatus, type EnvStatusStore } from '../environment/status.ts'
import { buildTagOf, useBuild, type BuildStore } from './build-store.ts'
import { BUILD_TAG_CLASSES, WORKBENCH_CLASSES as C } from './consts.ts'
import { envMarkTitle, isUnderDevelopment, MODULE_IDS, moduleLabel, type ModuleId } from './modules.ts'
import { useModule, useModuleStore, type ModuleStore } from './module-store.ts'

/**
 * 侧栏底部（Settings 上方）常驻的工作台入口 —— 现在是一张**分组卡**。
 *
 * 形态（2026-09-22 用户确认的口径）：中瑞世联工作台是这侧栏里的**一个模块**，
 * 报告评估 / 报告审核 / 环境信息是它的三个子项。做法就是 Apple 设置面板里那种
 * 「分组卡」：一张浅底圆角卡，卡头是模块名（+ 版本标签），卡身是三行子项，
 * 行与行之间靠留白分格；选中的那一行浮起来（品牌色低浓度底 + 左侧 3px 强调条 + 加粗），
 * 悬停给一层极浅的中性底色。**它们看起来是一个整体，而不是三个碰巧挨着的入口。**
 *
 * 只有子项能点：**卡头是纯标题，既不可点、也没有悬停底色**（用户口径：「中瑞世联工作台
 * 这个本身不应该能选中」）。要打开工作台面板就点子项 —— 点当前子项等于「重新进入它」
 * （store 会推进 selectEpoch，面板据此重置门禁）。
 *
 * 折叠成 56px 轨道时只留品牌标记 + 环境标记：轨道宽度放不下卡头 + 三行子项，
 * 硬塞会把名字截成省略号，比不显示更糟。这时结论都靠 title/aria 传达。
 */

/** 主面板 key：底部入口与 `main` 席位靠这个字符串对齐。 */
export const WORKBENCH_PANEL_KEY = 'crwu-workbench'

/** 面板选中态的形状（只用到 activePanelId，避免把 DSH 的服务类型搬进客户端组件签名）。 */
export interface PanelInfoLike {
  activePanelId: string | null
}

export interface WorkbenchSidebarEntryProps {
  /** 由 `apply()` 创建并下发；与面板看到的是同一份结论。 */
  store: EnvStatusStore
  /** 「现在跑的是哪一份插件」（dev / 具体版本）。 */
  build: BuildStore
  /**
   * 由 `apply()` 创建并下发的模块状态：侧栏子项与面板里的页必须是同一个模块。
   * 缺省（单测直接渲染）时就地造一份，属于组件实例，不是模块级单例。
   */
  modules?: ModuleStore
  /** 选中工作台主面板（`layout.selectPanel`，由 apply 绑定好）。 */
  onOpen: () => void
  /** DSH 侧栏席位给的列宽状态：false = 折叠成轨道。 */
  wide?: boolean
  /**
   * DSH 注入的标准席位 hook：读「当前选中的主面板」。
   *
   * 它在真实运行时由框架恒定提供；测试里可以不传（那就当未选中）。
   * 因此这里的调用顺序对外只有「有 / 没有」两种稳定情形，不会在两次渲染之间变。
   */
  usePanelInfo?: (selector: (info: PanelInfoLike) => boolean) => boolean
}

const MARK_OF: Record<string, string> = {
  ok: C.sideEntryMarkOk,
  bad: C.sideEntryMarkBad,
  busy: C.sideEntryMarkBusy,
  idle: C.sideEntryMarkIdle,
}

const GLYPH: Record<ModuleId, (props: IconProps) => React.ReactElement> = {
  eval: EvalIcon,
  audit: AuditIcon,
  env: EnvIcon,
}

export function WorkbenchSidebarEntry(props: WorkbenchSidebarEntryProps): React.ReactElement {
  const modules = useModuleStore(props.modules)
  const current = useModule(modules)
  const snapshot = useEnvStatus(props.store)
  const build = useBuild(props.build)
  const tone = envLampOf(snapshot)
  const tag = buildTagOf(build)
  const active = props.usePanelInfo === undefined
    ? false
    : props.usePanelInfo((info) => info.activePanelId === WORKBENCH_PANEL_KEY)
  const wide = props.wide !== false

  React.useEffect(() => {
    // 这个入口在侧栏里常驻，是用户最先看到的那行字，所以由它负责**首次**自检与首次 `boot`。
    // 两个 store 都会做并发去重（面板几乎同时也挂载），所以这里不会打出两次请求。
    const env = props.store.get()
    if (env.env === null && !env.busy) void props.store.refresh()
    const info = props.build.get()
    if (info.rev === '' && info.error === '') void props.build.refresh()
    return undefined
  }, [props.store, props.build])

  const markClass = [C.sideEntryMark, MARK_OF[tone] ?? C.sideEntryMarkIdle].join(' ')
  // 环境结论标记 = 一枚 16px 圆徽标（iOS 设置风：实心色圆底 + 白字形）。
  // 它**只属于「环境信息」那一行** —— 挂在别的子项后面（报告评估 / 报告审核）会被读成
  // 「那一行通过了」，用户 2026-09-22 明确要求去掉那些、只留环境那一栏。
  //   通过   = 实心绿圆 + 白勾
  //   不通过 = 实心红圆 + 白叹号
  //   自检中 = 实心琥珀圆 + 一段旋转白弧（弧画在 CSS 的 ::after 上）
  //   尚未自检 = 空心圈（不给结论，也不假装有结论）
  // 字形一律 currentColor，颜色与圆底都由 `.crwu-audit-side-entry-mark-*` 给。
  const mark = tone === 'ok'
    ? <BadgeCheckIcon size={12} />
    : (tone === 'bad' ? <BadgeWarnIcon size={12} /> : null)
  const title = `${zhCN.sidebarLabel} · ${tag.title}\n${envMarkTitle(tone)}`

  // 点子项 = 记住这个子项（store）+ 打开面板。切换写进 store 而不是本地 state，
  // 否则面板拿不到「用户刚点了哪个子项」，就会出现侧栏高亮着 A、面板显示 B。
  const choose = (id: ModuleId): void => {
    modules.select(id)
    props.onOpen()
  }

  if (!wide) {
    return <button
      type="button"
      className={[C.sideEntry, C.sideEntryRail, active ? C.sideEntryOn : ''].filter((item) => item !== '').join(' ')}
      title={title}
      aria-label={zhCN.sidebarLabel}
      aria-current={active ? 'page' : undefined}
      onClick={props.onOpen}
    >
      <span className={C.sideEntryGlyph}><BrandMark size={20} /></span>
      <span className={markClass}>{mark}</span>
    </button>
  }

  return <div
    className={[C.sideCard, active ? C.sideCardOn : ''].filter((item) => item !== '').join(' ')}
    title={title}
  >
    {/* 卡头：模块名 + 版本标签。**它是纯标题，不是第四个可选项** —— 没有 onClick、
        没有 cursor:pointer、没有悬停底色，点它什么也不会发生。 */}
    <div className={C.sideCardHead}>
      <span className={C.sideEntryGlyph}><BrandMark size={16} /></span>
      <span className={C.sideCardTitle}>{zhCN.sidebarLabel}</span>
      <span className={[C.version, BUILD_TAG_CLASSES[tag.tone]].join(' ')} title={tag.title}>{tag.text}</span>
    </div>

    {/* 卡身：三个子项，顺序固定（报告评估 / 报告审核 / 环境信息），不按条件重排。 */}
    <div className={C.sideCardRows}>
      {MODULE_IDS.map((id) => {
        const Glyph = GLYPH[id]
        // 「选中」= 工作台面板**正开着** + 这一页就是当前页。只认 store 里的 current.active
        // 会让用户在左侧栏点开任何一个会话之后，这里还高亮着上一次那个子项 —— 看起来像
        // 工作台还在前台（用户 2026-09-22 报的 bug）。面板切走就整块收起高亮，记忆仍在 store 里。
        const on = active && current.active === id
        return <button
          key={id}
          type="button"
          className={[C.module, on ? C.moduleOn : ''].join(' ')}
          aria-pressed={on}
          // 环境那一行的悬停文案顺带给出自检结论（结论色本身对色觉障碍用户不可读）。
          title={id === 'env' ? envMarkTitle(tone) : moduleLabel(id)}
          onClick={() => { choose(id) }}
        >
          <span className={C.moduleGlyph}><Glyph size={15} /></span>
          <span className={C.moduleLabel}>{moduleLabel(id)}</span>
          {/* 还没开发的子项跟一枚灰色的「开发中」小标签（用户 2026-09-22 口径：
              图标难看，换回一个灰色小 tag）。 */}
          {isUnderDevelopment(id) ? <span className={C.moduleTag}>{zhCN.moduleDevTag}</span> : null}
          {/* 环境结论只画在「环境信息」这一行；其余子项右侧留空。 */}
          {id === 'env' ? <span className={markClass}>{mark}</span> : null}
        </button>
      })}
    </div>
  </div>
}
