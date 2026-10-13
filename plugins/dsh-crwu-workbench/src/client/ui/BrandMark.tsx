import * as React from 'react'

/**
 * 中瑞世联的品牌标记（按用户给的原图逐个像素描出来的矢量版）。
 *
 * ## 为什么是四个多边形而不是一张位图
 *
 * 客户端产物是单文件 `lib/client.js`，**没有资源加载器**：位图要么内联成 base64（体积与
 * 缩放糊掉两个问题都有），要么额外发一个文件（`files` 与 `pack:assert` 都要跟着动）。
 * 描成矢量后它跟着主题一起缩放，16px 的侧栏图标与 40px 的弹窗标题都是同一份清晰图形，
 * 而且**没有颜色硬编码在样式表里**（样式表禁用硬编码色值的测试不会受影响）。
 *
 * ## 图形是从原图反推出来的
 *
 * 原图 122x124、纯色三色（白底 / 品牌红 `#b50120` / 品牌金 `#cf9950`）。把非白像素按
 * 每行的颜色分段读出来，得到四个连通块的边界：左上红块是「右边界先竖直、再被一条 `/` 斜线
 * 切向左下」的五边形，金色块是左上角被同一个方向的斜线切掉的六边形，左下红块与右下红块各自
 * 带一条 `/` 斜切边。下面的坐标**逐字抄自那次测量**（原图坐标整体平移 -4，视框 101x104）：
 *
 * - 重建后用同一套分段算法逐像素比对，**没有任何一个不一致像素离多边形边超过 2px**
 *   （全部落在抗锯齿过渡带上），所以形状是对的，不是"看着差不多"。
 *
 * ## 颜色为什么不走主题变量
 *
 * 品牌色不是界面语义色：暗色主题下把红改成灰会让它不像中瑞世联的标记。
 * 这两个值也**只出现在这里**（不在 `WORKBENCH_STYLE_TEXT` 里），所以"样式里不许硬编码色值"
 * 那条测试仍然成立。深色模式下品牌红/金的对比度足够（红 #b50120 在浅底上、金 #cf9950 在深底上
 * 都清晰），这一版不做主题化变体。
 */

/** 原图标描出的四块（顺序即绘制顺序，块之间无重叠）。 */
const BRAND_RED = '#b50120'
const BRAND_GOLD = '#cf9950'

const SHAPES: readonly { points: string; fill: string }[] = [
  // 左上：右边界先竖直（y 0→26），再沿 `/` 斜线到 (25,51)。
  { points: '0,0 50,0 50,26 25,51 0,51', fill: BRAND_RED },
  // 金色：左下角被同一方向的斜线切掉，左边界在 y=26 处收成竖直线 x=51。
  { points: '77,0 101,0 101,26 76,51 51,51 51,26', fill: BRAND_GOLD },
  // 左下：顶边水平（y=51），右下角再被 `/` 斜线切一刀。
  { points: '0,76 25,51 50,51 50,78 24,104 0,104', fill: BRAND_RED },
  // 右下：左上角被 `/` 斜线切掉，其余是实心方块。
  { points: '78,51 101,51 101,104 51,104 51,78', fill: BRAND_RED },
]

/** 视框（原图 bbox 平移 -4 后的尺寸）。 */
const VIEW_W = 101
const VIEW_H = 104

export interface BrandMarkProps {
  /** 图形宽度（px）；高度按原图比例 104/101 自动算出。 */
  size?: number
  className?: string
  /**
   * 无障碍名称。默认 `aria-hidden`：标记几乎总是紧挨着「中瑞世联工作台」这几个字出现，
   * 再读一遍品牌名是噪声。只有单独使用（没有伴随文字）时才传它。
   */
  label?: string
}

export function BrandMark(props: BrandMarkProps): React.ReactElement {
  const width = typeof props.size === 'number' ? props.size : 16
  const height = Math.round((width * VIEW_H) / VIEW_W * 100) / 100
  const label = props.label
  return <svg
    width={width}
    height={height}
    viewBox={`0 0 ${String(VIEW_W)} ${String(VIEW_H)}`}
    className={props.className}
    role={label === undefined ? undefined : 'img'}
    aria-label={label}
    aria-hidden={label === undefined ? true : undefined}
    focusable={false}
  >
    {SHAPES.map((shape) => <polygon key={shape.points} points={shape.points} fill={shape.fill} />)}
  </svg>
}
