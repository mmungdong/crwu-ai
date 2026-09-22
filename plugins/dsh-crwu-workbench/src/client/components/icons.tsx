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

/** 未通过 / 需要处理：圆里一枚感叹号（比叉号少一点"终结"意味，更像"待办"）。 */
export function WarnIcon(props: IconProps): React.ReactElement {
  const box = frame(props.size, props.className)
  return <svg {...box} {...STROKE}>
    <circle cx={12} cy={12} r={8.5} />
    <path d="M12 7.8v4.9" />
    <path d="M12 16.1h.01" />
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
