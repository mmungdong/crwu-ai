/**
 * 共享 UI：按钮 / 次级控件（Ghost）。
 *
 * 按钮是这套视觉里唯一「有重量」的元素：一屏里**最多一处实心**（主操作），其余都是中性面或 Ghost。
 * 变体一律写成**双类**选择器（`(0,2,1)`）：基础按钮只有 `(0,1,0)`，同特异度下会被排在更后的
 * 规则吃掉 —— 那正是历史缺陷「悬停主按钮整个全黑」的根因（深底 + 深字）。双类不依赖书写顺序。
 */

export const CRWU_BUTTON_STYLE_TEXT = `
/* ════════════════════════════════════════════════════════════════════
   18. 按钮 / 图标按钮 / 输入 / 抽屉 / 键值表
   ────────────────────────────────────────────────────────────────────
   按钮是这套视觉里唯一「有重量」的元素：一屏里**最多一处实心**（主操作），
   其余都是中性面或 Ghost —— 这是 Apple 的层级感做法，也是办公场景里防误点的需要。
   ──────────────────────────────────────────────────────────────────── */
.crwu-audit-btn {
  box-sizing: border-box; height: 30px; padding: 0 12px;
  border-radius: 8px; border: 1px solid var(--crwu-border-strong);
  background: var(--crwu-surface); color: var(--crwu-text-primary);
  font-family: inherit; font-size: 13px; font-weight: 500; line-height: 18px;
  cursor: pointer; white-space: nowrap;
  transition: background 120ms var(--crwu-ease), border-color 120ms var(--crwu-ease),
    color 120ms var(--crwu-ease), transform 120ms var(--crwu-ease), box-shadow 120ms var(--crwu-ease);
}
.crwu-audit-btn:hover:not(:disabled) { background: var(--crwu-hover); }
.crwu-audit-btn:active:not(:disabled) { transform: scale(0.97); }
.crwu-audit-btn:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: 2px; }
.crwu-audit-btn:disabled { opacity: 0.45; cursor: not-allowed; }
/* 变体一律「双类」选择器（(0,2,0)）：基础按钮只有 (0,1,0)，同特异度下会被排在更后的规则吃掉
   —— 那正是历史缺陷「悬停主按钮整个全黑」的根因（深底 + 深字）。双类不依赖书写顺序。 */
.crwu-audit-btn.crwu-audit-btn-primary {
  height: 32px; padding: 0 12px;
  border-color: transparent; background: var(--crwu-primary-bg); color: var(--crwu-primary-text);
}
.crwu-audit-btn.crwu-audit-btn-primary:hover,
.crwu-audit-btn.crwu-audit-btn-primary:hover:not(:disabled) {
  background: var(--crwu-primary-bg-hover);
  transform: translateY(-1px);
}
.crwu-audit-btn.crwu-audit-btn-primary:active:not(:disabled) { transform: scale(0.97); }
/* 警示变体（行内「确认重新审核」）：琥珀字 + 琥珀描边，与旁边的「取消」区分开。 */
.crwu-audit-btn.crwu-audit-btn-warn {
  border-color: color-mix(in srgb, var(--crwu-risk-b) 55%, transparent);
  color: var(--crwu-risk-b); background: var(--crwu-surface);
}
.crwu-audit-btn.crwu-audit-btn-warn:hover:not(:disabled) { background: var(--crwu-hover); }
.crwu-audit-btn-small { height: 28px; padding: 0 10px; font-size: 12px; }

/* 次级控件（列表工具条的「刷新」/ 操作列的小鲸鱼 / ••• / 流水号复制）：
   **同一套中性底 + 同一套悬停格**（--crwu-control*），只有主操作是实心 —— 用户 2026-09-23 口径
   「操作列的按钮颜色不一致，还有刷新按钮」。刷新期间**只有图标转**：已有列表保持显示，
   不清空、不白屏、不位移。 */
.crwu-audit-ghost {
  box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px;
  height: 36px; padding: 0 10px; border: none; border-radius: 8px;
  background: var(--crwu-control); color: var(--crwu-control-text);
  font-family: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
  transition: background 120ms var(--crwu-ease), color 120ms var(--crwu-ease);
}
.crwu-audit-ghost:hover:not(:disabled) { background: var(--crwu-control-hover); color: var(--crwu-text-primary); }
.crwu-audit-ghost:active:not(:disabled) { background: var(--crwu-control-active); transform: scale(0.98); }
.crwu-audit-ghost:focus-visible { outline: 2px solid var(--crwu-brand); outline-offset: 2px; }
.crwu-audit-ghost:disabled { opacity: 0.45; cursor: not-allowed; }
.crwu-audit-ghost svg { flex: none; }
.crwu-audit-ghost-busy svg { animation: crwu-audit-ghost-spin 900ms linear infinite; }
@keyframes crwu-audit-ghost-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .crwu-audit-ghost-busy svg { animation: none; }
}
`
