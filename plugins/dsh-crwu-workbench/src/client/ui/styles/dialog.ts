/**
 * 共享 UI：统一 Floating Layer（Tooltip + Dropdown + 对话框）。
 *
 * 都渲染在表格之外、`position: fixed` + 触发元素 rect 定位 —— 客户端产物只允许 require react
 *（没有 react-dom），这是 Portal 的等价实现，同时解决"被表格横向滚动容器裁掉"与"撑高行"两个问题。
 */

export const CRWU_DIALOG_STYLE_TEXT = `
/* ── 统一 Floating Layer（DeepSeek Tooltip + 操作列 Dropdown）─────────────────
   两个浮层共用一套视觉与动画；都渲染在**表格之外**、position: fixed + 触发元素 rect 定位
   —— 客户端产物只允许 require react（没有 react-dom），这是 Portal 的等价实现，
   同时解决"被表格横向滚动容器裁掉"与"撑高行"两个问题。 */
.crwu-audit-float {
  position: fixed; z-index: 40; box-sizing: border-box;
  background: var(--crwu-menu-bg); border: 1px solid var(--crwu-border);
  border-radius: 10px; box-shadow: var(--crwu-shadow-menu); color: var(--crwu-text-primary);
  -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px);
}
.crwu-audit-float-menu {
  min-width: 150px; padding: 5px;
  animation: crwu-audit-menu-in 160ms var(--crwu-ease) both;
}
@keyframes crwu-audit-menu-in {
  from { opacity: 0; transform: translateY(-4px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.crwu-audit-float-tip {
  padding: 7px 10px; border-color: transparent; border-radius: 8px;
  background: var(--crwu-tip-bg); color: var(--crwu-tip-text);
  box-shadow: var(--crwu-shadow-tip);
  font-size: 12px; font-weight: 500; line-height: 16px; white-space: nowrap; pointer-events: none;
  animation: crwu-audit-tip-in 160ms var(--crwu-ease) both;
}
@keyframes crwu-audit-tip-in {
  from { opacity: 0; transform: translateY(4px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
/* 箭头：与浮层同底、只留朝外两条边、贴边 4px（与浮层之间没有断层）。 */
.crwu-audit-float-arrow {
  position: absolute; width: 8px; height: 8px;
  background: var(--crwu-menu-bg); border: 1px solid var(--crwu-border);
}
.crwu-audit-float-tip .crwu-audit-float-arrow {
  left: 50%; bottom: -4px; transform: translateX(-50%) rotate(45deg);
  background: var(--crwu-tip-bg); border: none;
}
.crwu-audit-float-menu[data-flip="top"] .crwu-audit-float-arrow {
  left: 50%; bottom: -4px; transform: translateX(-50%) rotate(45deg); border-top: none; border-left: none;
}
.crwu-audit-float-menu[data-flip="bottom"] .crwu-audit-float-arrow {
  right: 12px; top: -4px; transform: rotate(225deg); border-top: none; border-left: none;
}
.crwu-audit-float-item {
  display: flex; align-items: center; width: 100%; height: 34px; padding: 0 10px;
  border: none; border-radius: 6px; background: transparent;
  color: var(--crwu-text-primary); font-family: inherit; font-size: 13px; text-align: left; cursor: pointer;
  transition: background 110ms var(--crwu-ease);
}
.crwu-audit-float-item:hover { background: var(--crwu-menu-hover); }
.crwu-audit-float-item:active { background: var(--crwu-selected); }
.crwu-audit-float-item:disabled { color: var(--crwu-text-tertiary); cursor: default; }
.crwu-audit-float-item:focus-visible { outline: 2px solid var(--crwu-interactive); outline-offset: -2px; }

/* 拉取报告资料 / 首次加载报告：等待页**只盖列表数据区**（页头 / 页签 / 工具条保持可见）。 */
.crwu-audit-list-area { position: relative; min-height: 360px; }
.crwu-audit-ai-mask {
  position: absolute; inset: 0; z-index: 8; display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--crwu-surface) 82%, transparent);
}
.crwu-audit-ai-mask .crwu-audit-loading-pane { min-height: 320px; padding: 24px 12px; }
/* 「已有报告会话」的选择 Dialog：浮层 + 轻遮罩，两个选项是并排的两块可点面。 */
.crwu-audit-ai-dialog-backdrop { position: fixed; inset: 0; z-index: 10; background: var(--crwu-scrim); }
.crwu-audit-ai-dialog {
  position: fixed; z-index: 11; top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: 420px; max-width: calc(100vw - 48px); box-sizing: border-box;
  padding: var(--crwu-space-5); border-radius: var(--crwu-radius-lg);
  border: 1px solid var(--crwu-border-strong); background: var(--crwu-popover-bg);
  box-shadow: var(--crwu-shadow-dialog);
  animation: crwu-audit-float-in 160ms var(--crwu-ease) both;
}
@keyframes crwu-audit-float-in {
  from { opacity: 0; transform: translate(-50%, -50%) translateY(6px) scale(0.98); }
  to { opacity: 1; transform: translate(-50%, -50%) translateY(0) scale(1); }
}
.crwu-audit-ai-dialog-title { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; color: var(--crwu-text-primary); }
.crwu-audit-ai-dialog-body { margin-top: var(--crwu-space-2); font-size: 13px; line-height: 20px; color: var(--crwu-text-secondary); }
.crwu-audit-ai-dialog-option {
  box-sizing: border-box; width: 100%; margin-top: var(--crwu-space-3); padding: var(--crwu-space-3);
  text-align: left; cursor: pointer; border: 1px solid var(--crwu-border); border-radius: var(--crwu-radius-md);
  background: var(--crwu-surface-subtle); font-family: inherit;
  transition: background 120ms var(--crwu-ease), border-color 120ms var(--crwu-ease);
}
.crwu-audit-ai-dialog-option:hover { background: var(--crwu-hover); border-color: var(--crwu-border-strong); }
.crwu-audit-ai-dialog-option:focus-visible { outline: 2px solid var(--crwu-interactive); outline-offset: -2px; }
.crwu-audit-ai-dialog-option-on { border-color: var(--crwu-interactive-border); }
.crwu-audit-ai-dialog-option-title { display: block; font-size: 13px; font-weight: 600; color: var(--crwu-text-primary); }
.crwu-audit-ai-dialog-option-hint { display: block; margin-top: 2px; font-size: 12px; color: var(--crwu-text-secondary); }
.crwu-audit-ai-dialog-actions { display: flex; justify-content: flex-end; margin-top: var(--crwu-space-4); }
`
