import * as React from 'react'

/**
 * 工作台的线性图标集。
 *
 * 为什么自己画而不引第三方图标库：客户端产物只允许 `require('react')`（见 AGENTS.md §4.1.1），
 * 任何额外依赖都装不进 DSH 的模块表。这些图标刻意保持同一套笔画语言 ——
 * **1.6px 描边、圆头圆角、currentColor 着色、24 视框**，跟 DSH 自带图标放在一起不打架。
 *
 * 颜色一律 `currentColor`：这样调用方只需要改文字颜色（或套 `.crwu-audit-*-mark-ok` 这类
 * 语义类），不用给 SVG 传色值 —— 也就不会在样式表里出现硬编码颜色。
 */

export interface IconProps {
  size?: number
  className?: string
}

function frame(size: number | undefined, className: string | undefined): {
  width: number
  height: number
  className: string | undefined
} {
  const edge = typeof size === 'number' ? size : 16
  return { width: edge, height: edge, className }
}

const STROKE = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

/** 通过 / 已就绪：一枚对勾（侧栏底部入口右侧那颗绿勾就是它）。 */
export function CheckIcon(props: IconProps): React.ReactElement {
  const box = frame(props.size, props.className)
  return <svg {...box} {...STROKE}>
    <path d="M5 12.6 10 17.5 19 7" />
  </svg>
}

/** 报告评估：一根带阈值的走势线（评估结论的语义）。 */
export function EvalIcon(props: IconProps): React.ReactElement {
  const box = frame(props.size, props.className)
  return <svg {...box} {...STROKE}>
    <path d="M4 19.5h16" />
    <path d="M4 15.5 9 10.5l3.6 3.4L20 6" />
    <path d="M20 10V6h-4" />
  </svg>
}

/** 报告审核：一份带对勾的清单。 */
export function AuditIcon(props: IconProps): React.ReactElement {
  const box = frame(props.size, props.className)
  return <svg {...box} {...STROKE}>
    <rect x={4.5} y={3.5} width={15} height={17} rx={3} />
    <path d="M8.5 9h4" />
    <path d="M8.5 13h2.5" />
    <path d="m13.5 15.4 2 1.9 3-3.3" />
  </svg>
}

/** 环境信息：一排推杆（配置/自检的语义）。 */
export function EnvIcon(props: IconProps): React.ReactElement {
  const box = frame(props.size, props.className)
  return <svg {...box} {...STROKE}>
    <path d="M6 4v6" />
    <path d="M6 14v6" />
    <path d="M12 4v3" />
    <path d="M12 11v9" />
    <path d="M18 4v9" />
    <path d="M18 17v3" />
    <circle cx={6} cy={12} r={2} />
    <circle cx={12} cy={9} r={2} />
    <circle cx={18} cy={15} r={2} />
  </svg>
}

/** 开发者诊断：终端窗口 + 命令提示符，只用于收起的技术诊断入口。 */
export function DeveloperDiagnosticsIcon(props: IconProps): React.ReactElement {
  const box = frame(props.size, props.className)
  return <svg {...box} {...STROKE}>
    <rect x={3.5} y={4.5} width={17} height={15} rx={3} />
    <path d="m7.5 9 2.5 2.5L7.5 14" />
    <path d="M12.5 14h4" />
  </svg>
}

/** 未通过 / 需要处理：圆里一枚感叹号（比叉号少一点"终结"意味，更像"待办"）。 */
export function WarnIcon(props: IconProps): React.ReactElement {
  const box = frame(props.size, props.className)
  return <svg {...box} {...STROKE}>
    <circle cx={12} cy={12} r={8.5} />
    <path d="M12 7.8v4.9" />
    <path d="M12 16.1h.01" />
  </svg>
}

/**
 * 刷新：一段带箭头的整圆。
 *
 * 与「重新自检」那个转圈不同 —— 这只是**列表工具条**里的一次重新拉取，
 * 所以图标本身是静态的，转起来由 `.crwu-audit-ghost-busy` 那条 transform 动画负责。
 */
export function RefreshIcon(props: IconProps): React.ReactElement {
  const box = frame(props.size, props.className)
  return <svg {...box} {...STROKE}>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
    <path d="M19.6 4.6v4.2h-4.2" />
  </svg>
}

/** 复制：两张错开的纸（流水号那类辅助信息的悬停动作）。 */
export function CopyIcon(props: IconProps): React.ReactElement {
  const box = frame(props.size, props.className)
  return <svg {...box} {...STROKE}>
    <rect x={9} y={9} width={11} height={11} rx={2.6} />
    <path d="M15.2 6.4A2.4 2.4 0 0 0 13 4H6.6A2.6 2.6 0 0 0 4 6.6V13a2.4 2.4 0 0 0 2.4 2.2" />
  </svg>
}

/** 搜索：一枚放大镜（放在输入框左侧，只做形状提示、不参与交互）。 */
export function SearchIcon(props: IconProps): React.ReactElement {
  const box = frame(props.size, props.className)
  return <svg {...box} {...STROKE}>
    <circle cx={11} cy={11} r={6.4} />
    <path d="m15.8 15.8 3.6 3.6" />
  </svg>
}

/** 尚未开发的模块：一只沙漏，比问号更少「报错」味。 */export function PendingIcon(props: IconProps): React.ReactElement {
  const box = frame(props.size, props.className)
  return <svg {...box} {...STROKE}>
    <path d="M7 3.5h10" />
    <path d="M7 20.5h10" />
    <path d="M8 3.5v3.2c0 1.4.7 2.4 2.2 3.4L12 11.4l1.8-1.3C15.3 9.1 16 8.1 16 6.7V3.5" />
    <path d="M8 20.5v-3.2c0-1.4.7-2.4 2.2-3.4L12 12.6l1.8 1.3c1.5 1 2.2 2 2.2 3.4v3.2" />
  </svg>
}

/**
 * 实心状态徽标里的**加粗字形**（侧栏环境标记那种 16px 圆底，iOS 设置风）。
 *
 * 为什么不复用上面的线性图标：那套是「1.6px 描边 / 24 视框」的细线条语言，缩到 11~12px 时
 * 实际笔画只剩 0.7px，压在实心色块上会糊成灰边；而且 `WarnIcon` 自带一圈描边圆，
 * 放进实心圆里就成「圆中圆」。这一组统一 **3px 描边、不带外圈**——圆由容器画。
 */
const BADGE_STROKE = { ...STROKE, strokeWidth: 3 }

/** 通过：一枚加粗对勾（配实心绿圆 = 白勾）。 */
export function BadgeCheckIcon(props: IconProps): React.ReactElement {
  const box = frame(props.size, props.className)
  return <svg {...box} {...BADGE_STROKE}>
    <path d="M5 12.7 10 17.6 19 7" />
  </svg>
}

/** 不通过：一枚加粗感叹号（配实心红圆 = 白叹号）。 */
export function BadgeWarnIcon(props: IconProps): React.ReactElement {
  const box = frame(props.size, props.className)
  return <svg {...box} {...BADGE_STROKE}>
    <path d="M12 6.4v7.1" />
    <path d="M12 17.6h.01" />
  </svg>
}

/**
 * DeepSeek 的官方标记（用户 2026-09-22 直接给了 SVG 路径：`viewBox 0 0 23.16 17.04`，
 * 填充式 `fill="currentColor"`）。
 *
 * 三条口径：
 * 1. **逐字用用户给的路径**（23.16 : 17.04 的宽扁比例），不自己描、不拉伸成正方形 ——
 *    之前那版自绘的鲸尾被用户否掉了（"你的那个太丑了"）；
 * 2. 它是**填充**图形，不跟本仓线性图标的 1.6px 描边语言共用属性，所以只借 `frame()` 定尺寸，
 *    颜色走 `currentColor`（悬停/选中变色由外面那层按钮的 color 决定）；
 * 3. 高度按比例算，宽度由调用方给（默认 16）。
 */
export function DeepSeekIcon(props: IconProps): React.ReactElement {
  const width = typeof props.size === 'number' ? props.size : 16
  const height = Math.round((width * 17.04) / 23.16 * 100) / 100
  return <svg
    width={width}
    height={height}
    className={props.className}
    viewBox="0 0 23.16 17.04"
    fill="none"
    aria-hidden={true}
  >
    <path
      d="M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.643 7.51636 12.39 7.51636C12.2955 7.51636 12.209 7.47486 12.1445 7.44136C12.039 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.277 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z"
      fill="currentColor"
    />
  </svg>
}

/**
 * 「报告评估」Coming Soon 页的功能图形：一份文档 + 一颗 AI 星芒。
 *
 * 为什么是这两个而不是施工帽/机器人/告警：这一页要传达的是"规划中的正式能力"，
 * 不是"坏了"或"在修"。文档 = 报告本体，星芒 = AI 辅助 —— 与模块名「报告评估」同义，
 * 且都在本仓既有的线性图标语言里（1.6px / currentColor / 24 视框）。
 */
export function DocSparkIcon(props: IconProps): React.ReactElement {
  const box = frame(props.size, props.className)
  return <svg {...box} {...STROKE}>
    <path d="M6.5 3.5h7.2L18.5 8v11.2a1.3 1.3 0 0 1-1.3 1.3H6.5a1.3 1.3 0 0 1-1.3-1.3V4.8a1.3 1.3 0 0 1 1.3-1.3Z" />
    <path d="M13.5 3.7V8h4.7" />
    <path d="M8 12.6h5.4M8 15.8h8" />
    {/* AI 星芒：四角星，比通用 sparkles 更克制（只有一颗，且更小）。 */}
    <path d="M18.2 14.2l.75 1.85 1.85.75-1.85.75-.75 1.85-.75-1.85-1.85-.75 1.85-.75.75-1.85Z" />
  </svg>
}
