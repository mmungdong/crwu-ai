/**
 * 插件级基础层：面板骨架、排布工具类、统一等待页。
 *
 * 这些规则的主体是**作用域节点自己**（`.crwu-audit-root`），所以选择器写成
 * `[data-crwu-scope="workbench"].crwu-audit-root` —— 打包时的后代式限定对它们不成立
 *（`:where([…]) .crwu-audit-root` 要求"祖先里有作用域节点"，而它自己就是那个节点）。
 */

export const CRWU_BASE_STYLE_TEXT = `
/* ════════════════════════════════════════════════════════════════════
   0. 骨架：面板 = 固定头部 + 可滚正文
   ────────────────────────────────────────────────────────────────────
   滚动归属这一条是必须的，不是样式偏好：DSH 的主内容列（centerCol）是
   display:flex + overflow:hidden + height:100vh，它**不滚动**，而是把滚动交给面板。
   这里把滚动放在 .crwu-audit-body 而不是 root，头部因此常驻 —— 让 root 滚的话
   标题与版本标签会跟着滚出视口。整体仍是「面板自己拥有滚动」。
   （三个模块的入口在左侧栏那张分组卡上，面板里不再有自己的模块条。）
   ──────────────────────────────────────────────────────────────────── */
/* 作用域节点的**盒模型基线**：任何一个挂载点都不该依赖宿主把 box-sizing 设成什么。
   （字体与颜色不在这里强设：侧栏入口 / 会话头按钮长在宿主外观里，继承宿主的字体才是一致的样子；
   面板那一层自己会显式声明 font-family / font-size / color。） */
[data-crwu-scope="workbench"] {
  box-sizing: border-box;
}
[data-crwu-scope="workbench"].crwu-audit-root {
  box-sizing: border-box;
  display: flex; flex-direction: column;
  height: 100%; min-height: 0; overflow: hidden;
  font-family: var(--dsw-font-family);
  font-size: 13px; line-height: 1.6;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  -webkit-font-smoothing: antialiased;
}
/* 正文区：**两级目录常驻在上面，滚动交给页面内容区**（.crwu-audit-tab-panel）。
   这一层自己不再滚 —— 否则目录条会跟着内容滚走，而"一级目录始终固定在页面顶部"是硬要求。
   滚动容器只有一个（页面内容区），所以切目录时宽度、高度与滚动位置都稳定。 */
.crwu-audit-body {
  flex: 1 1 auto; min-height: 0; overflow: hidden;
  display: flex; flex-direction: column;
  overscroll-behavior: contain;
  padding: 0;
}

.crwu-audit-header {
  flex: none; display: flex; align-items: center; gap: 10px;
  padding: 14px 22px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
}
/* 头部右侧那句问候：不抢标题的注意力，但要比正文稍重一点（它带姓名，是"给这个人看的"）。 */
.crwu-audit-greeting {
  flex: none; margin-left: auto;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px; line-height: 20px;
  white-space: nowrap;
}
.crwu-audit-title {
  font-size: 15px; font-weight: 600; letter-spacing: -0.01em;
  line-height: 22px;
  /* 头部是一行不许溢出的：窄面板下标题先被截断，版本标签与右侧那句问候永远看得见。 */
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 版本 / dev 小标签：跟着名字或标题走的一枚胶囊。
   等宽字体 + user-select:all，用户截图报问题时连着版本号一起选中，不用手打。
   dev 用琥珀色提醒「这不是装好的包，改了得重新 build」，装好的包用中性灰。 */
.crwu-audit-version {
  flex: none;
  padding: 0 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-caption);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px;
  line-height: 16px; letter-spacing: 0.02em; white-space: nowrap;
  user-select: all; cursor: default;
}
.crwu-audit-version-dev {
  color: var(--dsw-alias-state-warn-primary);
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
}
.crwu-audit-version-installed { color: var(--dsw-alias-label-secondary); }
.crwu-audit-version-unknown { color: var(--dsw-alias-label-caption); }
.crwu-audit-description { margin-top: 4px; color: var(--dsw-alias-label-secondary); }
.crwu-audit-error { margin-top: 8px; color: var(--dsw-alias-state-error-primary); }
.crwu-audit-result {
  margin-top: 10px; white-space: pre-wrap; overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
}

/* ════════════════════════════════════════════════════════════════════
   7. 排布工具类
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.crwu-audit-stack { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.crwu-audit-divider { height: 1px; background: var(--dsw-alias-border-l1); margin: 14px 0; }
.crwu-audit-muted { color: var(--crwu-text-secondary); }
.crwu-audit-mono { font-family: var(--crwu-font-mono); font-size: 12.5px; }
.crwu-audit-link { color: var(--dsw-alias-link); overflow-wrap: anywhere; }
.crwu-audit-grow { flex: 1 1 auto; }

/* ════════════════════════════════════════════════════════════════════
   3. 统一的「正在自检环境」等待页
   ────────────────────────────────────────────────────────────────────
   第一次点进工作台会跑一轮环境自检（工具 / 登录态 / 上传配置 / 外部数据），这几秒里
   整块正文只放这一页：会依次亮起来的品牌标记 + 两行字 + 一条不确定进度条。
   先前渲染的是**环境信息页的半成品**，看起来像"页面缺了一块"（用户 2026-09-22 口径：
   「需要一个统一的 loading 页面…这个注意有个好看的 svg」）。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-loading-pane {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; min-height: 360px; padding: 40px 24px; text-align: center;
}
/* 品牌标记当加载符号：整体极轻地呼吸（1 → 1.04 → 1，1.8s），四个色块再按顺序依次亮起
   （见下面 nth-child 的延迟）—— 没有旋转、没有大幅缩放、没有渐变光晕。 */
.crwu-audit-loading-mark {
  display: inline-flex; margin-bottom: 6px;
  animation: crwu-audit-breathe 1.8s ease-in-out infinite;
}
.crwu-audit-loading-mark svg polygon { animation: crwu-audit-brand-wave 1.6s ease-in-out infinite; }
.crwu-audit-loading-mark svg polygon:nth-child(2) { animation-delay: 0.14s; }
.crwu-audit-loading-mark svg polygon:nth-child(3) { animation-delay: 0.28s; }
.crwu-audit-loading-mark svg polygon:nth-child(4) { animation-delay: 0.42s; }
.crwu-audit-loading-title { font-size: 15px; font-weight: 600; line-height: 22px; }
.crwu-audit-loading-hint {
  max-width: 420px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px; line-height: 20px;
}
/* 进度条限宽：等待页里它是一条"心跳"，不该横贯整个正文。 */
.crwu-audit-loading-pane .crwu-audit-load-bar { width: 168px; margin: 10px 0 0; }

@keyframes crwu-audit-brand-wave {
  0%, 100% { opacity: 0.25; }
  35% { opacity: 1; }
}
@keyframes crwu-audit-breathe {
  0%, 100% { transform: scale(1); opacity: 0.7; }
  50% { transform: scale(1.04); opacity: 1; }
}
/* 尊重系统的"减少动态效果"：关掉动画，但页面结构与文案不受影响。 */
@media (prefers-reduced-motion: reduce) {
  .crwu-audit-loading-mark,
  .crwu-audit-loading-mark svg polygon,
  .crwu-audit-load-bar-fill { animation: none; }
}

.crwu-audit-load-bar {
  position: relative; height: 2px; margin: 0 0 12px; overflow: hidden;
  border-radius: 999px; background: var(--dsw-alias-interactive-bg-hover);
}
.crwu-audit-load-bar-fill {
  position: absolute; top: 0; left: 0; height: 100%; width: 35%;
  border-radius: 999px; background: var(--dsw-alias-brand-primary);
  animation: crwu-audit-load-slide 1.1s ease-in-out infinite;
}
@keyframes crwu-audit-load-slide {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(320%); }
}
.crwu-audit-dim { opacity: 0.55; pointer-events: none; }
`
