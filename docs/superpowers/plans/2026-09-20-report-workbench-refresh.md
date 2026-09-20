# Report workbench refresh implementation plan

> **历史文档（2026-09-20）**：本计划写作时本仓还并存一条动态 Cordis 形态（`legacy/host.js` +
> `legacy/client.js`），下文关于「两个自包含交付文件」「动态形态」的说法**已过时** ——
> 该形态已随 `0.1.2` 的收尾删除，`src/` 现在是唯一源码（见 `README.md` 与 `PORTING.md`）。

## Goal

Update the currently usable legacy workbench so the report page performs one
OSS object listing, marks reports that already have AI output, and reads the
selected result JSON only after the user opens “审核信息”. Keep the existing OSS
object names and overwrite behavior.

## Implementation slices

1. Add failing Host tests for an exact-key, prefix-confined OSS JSON reader and
   compact audit-result normalization.
2. Add failing Client tests for the “审核信息” action and lazy JSON request.
3. Extend H3Yun row mapping with the current human-review level, state, and node.
4. Add the Host `workbench:oss-result` operation. It uses `ossutil cat` for one
   JSON key, rejects keys outside the configured audit prefix, and returns only
   the summary/review-comparison fields needed by the UI.
5. Change the report page to:
   - load the H3Yun page and one cached OSS listing;
   - expose “待审核报告” and “AI审核结果” tabs;
   - show “审核信息” only when both result artifacts exist;
   - open a detail drawer and fetch only the chosen JSON;
   - keep the existing report HTML and upload paths unchanged.
6. Cache result details for the current workbench session. Clear the detail
   cache only when the OSS listing is explicitly refreshed.
7. Verify syntax, tests, hashes, and update legacy release metadata without
   committing.

## Source layout decision

DSH package plugins may use multiple TypeScript/TSX/CSS source files. Only the
configured entrypoints and bundled output filenames are fixed. Keep
`src/index.ts` and `src/client/index.ts` thin and move future package work into
`src/host`, `src/client/features`, `src/client/components`, and `src/shared`.

The dynamic `legacy/host.js` and `legacy/client.js` form is different: DSH
receives each half as one source string, so those two delivery artifacts must
remain self-contained until the package-form migration is complete.
