/**
 * Shared popover surface. Colours come only from `--crwu-*` tokens.
 */

export const CRWU_POPOVER_STYLE_TEXT = `
.crwu-ui-popover {
  position: fixed; z-index: var(--crwu-z-popover); box-sizing: border-box;
  border: 1px solid var(--crwu-popover-border); border-radius: var(--crwu-radius-lg);
  background: var(--crwu-popover-bg); box-shadow: var(--crwu-popover-shadow);
}
.crwu-ui-popover[data-crwu-exiting="true"] { pointer-events: none; }
@media (prefers-reduced-motion: reduce) {
  .crwu-ui-popover { transition: none; }
}
`
