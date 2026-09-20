# dsh-crwu-workbench · 中瑞世联工作台

DeepSeek Harness（DSH）里的**审核工作台**：环境自检 → 从氚云拉「报告审核」待办 → 一次只发起一条
AI 审核子会话 → 盯住它的运行状态、可随时停止/重启 → 交付件自动上阿里云 OSS → 直接打开云端审核意见。

审核流程本体不在本仓：它由 `crwu-audit` 技能族执行（见「依赖」）。本仓只负责**发起、盯状态、交付件回传**。

---

## 一、两个形态，别混

| | `legacy/` 动态插件形态 | `src/` 包形态 |
|---|---|---|
| 怎么活 | 在 DSH 会话里由 agent 调 `cordis_define` + `cordis_run` 装配 | `dsh plugin --profile web add …` 装进 profile，随 profile 启动 |
| 版本号 | DSH 的 `pkg-N` | semver（`package.json`） |
| 重启 DSH 后 | **消失**，要重装 | 还在 |
| 谁能改 | 任何编辑器改两个 JS 文件；**但生效必须在 DSH 里** | 任何能跑 `dsh` CLI 的人/agent 都能独立闭环 |
| 今天可用 | ✅ | 🚧 骨架阶段（见 `PORTING.md`） |

**收件人现在就用，走 `legacy/`。想按版本长期下发和回滚，等 `src/` 成形。**

---

## 二、收件人安装（legacy 路径，今天可用）

前提：对方机器上有 DSH、有一个能读文件并调用 Cordis 工具的 agent 会话。

1. 把这个仓拉下来：

   ```bash
   git clone <repo-url> && cd dsh-crwu-workbench
   ./install/verify.sh          # 校验两份源码未被改动（sha256 + node --check）
   ```

2. 把 [`install/INSTALL-PROMPT.md`](install/INSTALL-PROMPT.md) 的内容粘到对方 DSH 的对话里发出去。
   agent 会读 `legacy/host.js` + `legacy/client.js`，**一次** `cordis_define` 把两半一起定义，
   再 `cordis_run` 激活。两半必须同时发：只发一半会让浏览器端停在旧的 run 上，所有 RPC 变成
   `stale-run` 并被静默吞掉（界面上表现为「什么都不显示」）。

3. 让 agent 在会话里打开一次工作台运行卡片，或点会话头的「登记为子会话父级」——**必须在顶层会话里**，
   审核只允许挂在顶层会话下（只挂一层，嵌套会导致状态跟丢）。

4. 环境未就绪时工作台只显示「环境自检」页：点「复制提示词」把安装清单交给 agent，装完
   `crwu` / `dws` / `ossutil` / iFinD 密钥 / 氚云 + 钉钉登录后再回来。

### 更新版本

`legacy/` 形态没有自动升级：更新 = 重新跑一遍第 2 步（agent 会用同一个 `pluginId` 追加新 Package 再
`update`）。所以请让 agent 走 `kind:"existing"` + `mode:"update"`，不要新建 plugin。

### 卸载

让 agent 调 `cordis_undefine` 删掉 `crwu-1`。注意：**DSH 重启后插件本来就不存在了**，无需卸载。

---

## 三、分发前必须改的环境相关项

现在的源码是为作者本机配置的，别人直接装会写到作者的目录。分发前按需调整：

| 位置 | 现在的值 | 说明 |
|---|---|---|
| `legacy/host.js` `DEFAULT_CASE_ROOT` | `/Users/mungdong/crwu-audit-workspace` | 兜底案例根目录；正常情况下由「选定的工作空间」覆盖 |
| `DEFAULT_MANIFEST_SOURCE` | `crwu-only-workspace.oss-cn-beijing.aliyuncs.com/crwu-env-manifest.json` | 环境清单地址；每个组织应指向自己的 OSS |
| 清单里的 `oss.bucket` / `prefix` / `endpoint` | `crwu-workspace` / `crwu/audit` | 交付件上传目标 bucket |
| `DEFAULT_FORM_NAME` | `报告审核` | 氚云表单名 |

这些在包形态里都会变成 `cordis.patch.yml` 的 `config` 字段（见 `src/index.ts` 的 `Config`）。

---

## 四、开发工作流

- **改代码**：任何编辑器 / 任何 agent 都行。`legacy/` 是两个纯 JS 文件、零构建；改完先
  `./install/verify.sh`（会做 `node --check`，客户端半套一层 async 函数壳再查）。
- **让改动生效**：`legacy/` 形态**只能在 DSH 里**做最后一步 —— 只有 DSH 的 `cordis_define` +
  `cordis_run` 能把源码变成活插件。所以 Codex 之类的 agent 可以完成「改 + 校验 + 提 PR」，
  但「装上去看效果」要回到 DSH 会话交给 agent emit + run。
- **`src/` 包形态成形后**，最后一步变成 `dsh plugin --profile web add <pkg>#<tag>` + 重启 profile，
  是一条 shell 命令，Codex 就能独立完成整个闭环。

### 铁律（踩过的坑）

1. **一个 Package 是完整不可变版本**：改代码必须两半一起 emit。漏掉 `code.client` 会让浏览器端
   停留在旧 run，`invoke()` 按 run 对账后每次 `host.call` 都返回 `stale-run`，而面板里大多是
   `.catch(function () {})`，于是「什么都看不到」。
2. **不要手抄渲染树**：从文件读出来整段复制，不要凭记忆重打。
3. `legacy/host.js` 与 `legacy/client.js` **不要加注释头或版本头** —— 保持与运行版逐字一致，
   才能用 `cordis_inspect_self('crwu-1','<rev>')` 导出运行版直接 diff。版本信息写在
   `VERSION`、`legacy/REV`、`CHANGELOG.md`。

---

## 五、依赖（不在本仓）

- **技能族**：`crwu-audit` 及其资产/业务/公共子技能、`crwu-dws`、`crwu-h3yun-login`、
  `dingtalk-*`、`ifind-finance-data`。由安装清单负责安装。
- **CLI**：`crwu`（审核编排）、`dws`（钉钉）、`ossutil`（OSS 上传）。
- **账号**：氚云员工会话（钉钉扫码）、钉钉认证、阿里云 OSS AccessKey、iFinD 密钥。
  凭据分别落在 `~/.dsh/…`、`~/.ossutilconfig`（权限 600）、技能自己的配置里，**都不进本仓**。

---

## 六、目录

```
AGENTS.md          DSH 插件架构、目录、代码风格与测试规范
legacy/host.js     Host 半（沙箱函数体）：24 个 workbench:* RPC 处理器
legacy/client.js   Client 半：面板 UI + slots 注册
legacy/REV         rev / runId / sha256 / 捕获时间
install/           收件人安装提示词与校验脚本
src/index.ts       包形态 Host 轻入口（骨架）
src/host/          包形态 Host 配置、路由、操作与状态模块
src/client/        包形态 Client 装配、API、组件与 feature 模块
src/shared/        Host / Client 共享的协议常量与纯工具
cordis.patch.yml   包形态的装配补丁
PORTING.md         legacy → 包 的逐项移植清单
```

DSH 不要求 TypeScript 源码集中在单个文件。`src/` 应按领域拆分，构建后仍只暴露
`lib/index.js` 与 `lib/client.js` 两个入口；只有动态交付的 `legacy/host.js`、
`legacy/client.js` 需要保持自包含。

## 许可

内部使用。审核意见属内部材料：云端链接默认走**签名 URL**（带 bearer 签名，1 小时），不要改成公开读。
