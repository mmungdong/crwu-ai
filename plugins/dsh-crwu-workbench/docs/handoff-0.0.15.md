# 交接：dsh-crwu-workbench 0.0.15（未发版）

> 这份文档是**工作交接**，不是交付件。`docs/` 不在 `package.json` 的 `files` 里，
> 进包清单与任何门禁都不受影响；正式提交前可以删掉它。

## 0. 一句话现状

第三轮复审的 **4 个 P1 + 2 个 P2** 与整个 **F 段（停止状态机 + 当前审核会话入口）** 都已实现、
逐条用缺陷注入证伪、全量门禁通过。

> ⚠️ **状态已变化（2026-09-29 14:25 复核）：这批改动已经被用户自己提交并推送了。**
> 我此前的"未提交/未推送"表述已过期 —— 接手时以 git 为准，不要照抄旧叙述。

- 分支：`main`（跟踪 `origin/main`）
- `HEAD = origin/main = 6769a60`「Merge branch 'main' into feat/adapt_for_win」
  （用户的合并提交：27 个冲突都是重复历史造成的假冲突，用 `-s ours` 记关系，树与 `feat/adapt_for_win` 一致、内容零改动）
- 真正装这批改动的是 **`aa5377d`「fix windows」**：140 文件 / +16174 / −1074
  （含本文档提到的全部 Host/Client/测试/文档改动）
- **没有 `plugin-v0.0.15` tag**（本地与远端都没有）→ **还没发版**，发版仍是待办
- 工作树唯一未跟踪文件：`docs/handoff-0.0.15.md`（本文档；`docs/` 不进包，提交或删除都安全）
- 协议号：`WORKBENCH_PROTOCOL = 19`（本轮新增字段都是**可选**的，没有 +1；这点已请用户确认）

**下个会话第一件事**：`git log --oneline -3` 与 `git tag -l 'plugin-v0.0.15'` 各看一眼，
确认上面这条叙述仍成立，再决定是做发版还是继续修问题。

## 1. 四轮工作都做了什么（按时间）

| 轮次 | 主题 | 状态 |
| --- | --- | --- |
| — | **协议 19：审核 scope 绑定**（案例目录 = 唯一锚，记录 childId/seqNo/objectId/casePath/attemptId/允许附件，每案一个根、根 `meta.cwd` = 案例目录并回读） | 完成 |
| 二轮 | 用户 7 条（子会话策略复查边界、`toolFilter` 真边界、两阶段启动、dispose 超时=失败、bootstrap 身份核对、`targetKey` 不透明、`persistAudits=false`） | 完成 |
| 三轮 | 用户 6 条（必需集/deny 集拆分、窗口内不放行、失败回滚看 `quiesced`、`localAgent` + provider 限制、orphan pending 退役、真实 `StopOutcome`） | 完成 |
| 四轮 | **F 段**：两阶段停止状态机（F1）、阶段界面（F2）、当前审核摘要卡与「打开审核会话」（F3）、`audit-status` 契约（F4）、回归测试（F5） | 完成 |

## 2. 关键文件与职责（接手先读这几个）

**Host 安全边界**
- `src/host/audit/scope.ts` — `requireAuditScope` / `auditScopeFor` / `isAuditChild` / `auditScopeFor` 只认逐字相等的 `childId`；`callerParentSessionId` **只服务拒绝方向**。
- `src/host/audit/policy.ts` — 沙箱/审批判据唯一入口；边界与 cwd 必须等于本轮案例目录。
- `src/host/audit/root.ts` — 一个根只服务一个案例目录；工作空间级旧根判过期。
- `src/host/audit/spawn.ts` — `pickProvider`（只接受 `spawn`/`fork` + `toolFilter`）、`startChild`（保留 `localAgent`、传 `toolFilter.deny`）、`stopChild`（`quiesced` 判据 + `onPhase` 回调 + 有界等待）。
- `src/host/audit/ops.ts` — 两阶段启动（pending scope → 创建 → 写真 childId）、两阶段停止（`audit-stop` 只接受 + 后台推进阶段）、`stopViewOf` / `canStartNextNow`、退役记录。
- `src/host/audit/state.ts` — `stopAuditChild`（透传 `StopOutcome`，没静默就不丢身份）。
- `src/host/tools/consts.ts` — `REQUIRED_AUDIT_TOOLS` / `REQUIRED_AUDIT_CHILD_TOOLS` / `AUDIT_CHILD_DENIED_TOOLS`（**两集不许相交**，有门禁断言）。

**Client**
- `src/client/features/report-audit/stop-view.ts` — 停止阶段展示口径（纯函数）。
- `src/client/features/report-audit/ReportPane.tsx` — 「当前审核」摘要卡 + `aria-live` 阶段 + 补救动作。
- `src/client/features/workbench/WorkbenchPanel.tsx` — `stopRequestedAt`（100ms 级反馈）、`canStartNext` → `gating.canStart`、复制诊断。
- `src/shared/types.ts` / `src/client/features/report-audit/api.ts` — 线协议（`AuditStopView` / `stop` / `canStartNext` 可选）。

**测试（新增）**
- `tests/unit/host-audit-scope.test.mjs`、`tests/unit/client-stop-view.test.mjs`（纯函数）、`tests/unit/client-stop-card.test.mjs`（渲染）。
- 既有：`host-audit-lifecycle.test.mjs`（F1/F4 的 Host 用例）、`host-audit-spawn.test.mjs`、`host-tools.test.mjs`、`host-state-workspace.test.mjs`、`host-audit-root.test.mjs`、`host-audit-policy.test.mjs`。

**文档**
- `CHANGELOG.md`：三轮复查 + F 段小节（含"协议号为何仍 19"）。
- `docs/development-notes.md`：坑表 +20 行左右（本轮新增的每一条都有对应行）。
- `AGENTS.md`：§4.5 第 10 条（窗口内不放行任何东西）、§4.8 第 2/3 条、新增 §4.8.1 停止状态机。

## 3. 验证状态（在 `6769a60` 合并后的树上重跑过，2026-09-29）

```
typecheck ✅
test 1293 / pass 1289 / skip 1 / fail 3   ← 3 条是**已知环境假象**（见下）
build ✅   smoke:built ✅   pack:assert --strict ✅（480 文件 / 0.0.15）
bin:check ✅   skills:cli-guard ✅（155 文档 / 21 脚本，0 处裸 CLI）version/config ✅   git diff --check ✅
```

（`test` 的 3 条红是 `原生 shell 合同（posix）`：用例把 `process.execPath` 拷到临时目录再执行，
macOS 会杀掉被拷贝的签名二进制。它不是本次改动的产物，改代码前也一样。）

**3 条已知环境假象**：`原生 shell 合同（posix）` —— 用例把 `process.execPath`（Electron 二进制）
拷到临时目录再执行，macOS 会杀掉被拷贝的签名二进制（`expected: 0, actual: null`）。
另有一类"spawn npm ENOENT"红：只在没导出 `CRWU_NODE` / `CRWU_PNPM` 时出现。

**跑测试必须带的环境**（否则会多出与代码无关的红）：

```bash
export DSH_DESKTOP_NODE_EXECUTABLE="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
export CRWU_NODE="$DSH_DESKTOP_NODE_EXECUTABLE"
export CRWU_PNPM="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs"
export PATH="/tmp/crwu-bin:/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin:$PATH"
cd plugins/dsh-crwu-workbench
node --test --test-reporter=tap "tests/*.test.mjs" "tests/**/*.test.mjs"
```

**本轮注入证伪 14 处**（每条修复都有对应的红）：子会话必需集=根所需、复查退回根集、
恢复按父会话认领、服务退路放行、窗口内不落 pending、短路 `quiesced`（策略分支 + 手动停止）、
去掉 `localAgent` 优先、provider 回退、原样恢复 orphan pending、恢复空 childId 锁、
写死 stop 结果、卡上不禁用/无 aria-live、客户端自己推断 `canStartNext`、timeout 显示成已停止。

## 4. 待办（下个会话可以做的）

1. **真机验收**（只能人工做）：
   - 点停止后 100ms 内出现「正在请求停止审核…」；等待期间不出现无说明的空白；
   - 当前审核不在当前分页/筛选结果里时，顶部摘要卡与「打开审核会话」仍可见可用；
   - `aria-live` 播报与键盘焦点；timeout/failed 时不给"已停止"、不释放占用、不能起下一条；
   - Windows 与 macOS 同一套语义（本机无 `pwsh`，Windows 半边走 CI）。
2. **发布（当前最大的待办）**：跑 `docs/releasing.md` 的全套发布门禁
   （含 `compat:dsh` 真装 —— 本轮**没跑**），然后打 `plugin-v0.0.15` tag 触发 CI 发布。
   注意 `aa5377d` 已经把 0.0.15 的内容合进 `main`，所以发版只剩"门禁 + tag"这一步。
3. **用户还没回答的两个判断点**：
   - 协议号是否仍按 19（新增字段可选）；若要求 +1，改动点在 `src/shared/consts.ts` +
     几处断言（`host-package` / `host-update-operations` / `client-package`）。
   - `canStartNext` 在**旧宿主缺字段**时我按"没有正在停的审核"处理（否则老界面永久禁用）；
     若要"未知也禁止启动"，需把行按钮一起锁死（`WorkbenchPanel` 的 `gating.canStart`）。
4. **可选收紧**：`docs/desktop-acceptance-0.0.15.md` 与 `docs/review-0.0.15.md` 还没写 F 段的
   验收条目（P-19…）与证据指针；建议发版前补上，用户复审时按那两份走。

## 5. 不许退回去的口径（安全不变式）

1. **案例内操作的边界是本轮案例目录**，不是工作空间；`caseDir` 必须与记录 `casePath` 规范解析后精确相等。
2. **"名单"不是边界**：子会话的工具限制靠创建时传的 `toolFilter.deny`（既不进 prompt 也拒绝执行），
   不支持 `capabilities.toolFilter` 的 provider 在**创建之前**拒绝；`spawn`/`fork` 之外不选。
3. **窗口内不放行**：one-shot `start()` 没有预留 child id 的参数 → 没有权威 `childId` 就没有 scope，
   案例内 Tool 一律 fail closed；父会话判据只用于**拒绝**方向。
4. **没确认静默就不许丢身份**：`quiesced` 是唯一判据；不满足时写退役记录并保留句柄与占用。
5. **停止是状态机**：`audit-stop` 只接受，阶段逐段落盘，`canStartNext` **只由 Host 判定**；
   timeout/failed 一律不放行，且不看占用锁在不在。
6. **客户端缺字段按未知**：不许用 `status !== 'running'` 之类本地事实推断成 stopped/quiesced。

## 6. 操作纪律（踩过的坑）

- **绝不 `git checkout <path>` 还原**：本仓长期未提交，会丢成果；备份/还原都用 `cp`（本轮
  用 `/tmp/crwu-bak*.ts(x)`）。
- 长时间构建前 `rm -rf /tmp/crwu-build-lock`（陈旧锁会让 build 卡住）。
- 批量改测试夹具时**别用不严谨的正则**：本轮我把两个测试文件改坏过一次（注入片段落进方法体），
  用等值替换才精确还原；改夹具优先"在 ctx 工厂里统一包一层"，不要逐处正则插入。
- 夹具本身也要被证伪：本轮抓到三类假绿/假红 —— 夹具不模拟 `toolFilter`、`dispose` 写在
  `handle.run` 的里层（用例走了另一条分支）、以及 `timeout` 文案"无法确认子会话**已停止**"
  被整篇 `includes` 误判（改成比整行开头）。
