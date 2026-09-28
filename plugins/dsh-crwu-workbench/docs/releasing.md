# dsh-crwu-workbench 发布手册

本文是 `dsh-crwu-workbench` 的完整 npm 发版操作手册。它记录发布前提、版本变更、构建与验证、
Git tag 约定、GitHub Actions、npm 认证、发布后验收、失败恢复和回滚方式。

适用范围：

- npm 包：`dsh-crwu-workbench`
- 源码目录：`plugins/dsh-crwu-workbench/`
- npm registry：`https://registry.npmjs.org`
- 发布工作流：仓库根 `.github/workflows/release.yml`
- 发布触发 tag：`plugin-v<semver>`，例如 `plugin-v0.0.12`

> `v*` tag 留给仓库里的 Go CLI。插件发版必须使用 `plugin-v*`，不能使用 `v0.0.12`、`0.0.12`、`dsh-v0.0.12`
> 或其它前缀。

## 1. 发布原则

1. **同一个 npm 版本只发布一次。** npm 不允许覆盖已经发布的同名同版本包；即使撤回版本，也不能重用
   该版本号。任何代码、技能、配置、文档或构建内容变更都必须升版本。
2. **正式发布只走 tag 工作流。** 除首次建立 npm 包外，不在开发机手工执行真正的 `npm publish`。
3. **tag 必须指向已经合入主分支、通过 CI 的发布提交。** 不从未合并的功能分支打正式发布 tag。
4. **发布包必须包含两个平台的六个二进制。** `darwin-arm64` 与 `win32-x64` 各包含
   `crwu`、`dws`、`ossutil`，并由 `bin/manifest.json` 记录 size 与 sha256。
5. **版本号有四个事实点，必须一致：**
   `package.json`、`package-lock.json` 根版本、`VERSION`、`src/host/consts.ts`；
   `CHANGELOG.md` 还必须存在相同版本的小节。
6. **发布到 npm 不等于发布到其它插件目录。** 本包是 DSH 包插件，员工通过 DSH 从 npm 安装。

## 2. 当前发布链路

发布链路如下：

```text
发布提交进入 main
        ↓
main CI 通过
        ↓
推送 plugin-v<version> tag
        ↓
GitHub Actions: release-plugin
        ↓
macOS job 交叉构建 crwu，并装配两个平台的 dws / ossutil
        ↓
Ubuntu job 执行完整门禁与严格 tarball 校验
        ↓
npm publish --provenance
        ↓
npm 验证 + 干净 DSH profile 安装验收
```

仓库当前的 `.github/workflows/release.yml` 使用：

- `NODE_AUTH_TOKEN=${{ secrets.NPM_TOKEN }}` 完成 npm 发布鉴权；
- `permissions.id-token: write` 与 `--provenance` 生成构建来源证明；
- `plugin-v*` tag 自动执行真实发布；
- `workflow_dispatch` 默认 `dry-run=true`，只验证、不发布。

因此，**当前工作流不是无 Token 的 Trusted Publishing**。只配置 `id-token: write` 不足以通过现有脚本；
仓库还必须存在 `NPM_TOKEN`，否则工作流会主动失败并报告未配置 secret。

## 3. 一次性发布配置

### 3.1 GitHub 权限

发布人需要：

- 能向 `main` 推送发布提交，或通过 PR 合入；
- 能创建并推送 `plugin-v*` tag；
- 能查看 GitHub Actions 运行结果；
- 如使用 Token 流程，能配置仓库 Actions secrets。

### 3.2 方案 A：当前可直接使用的 NPM_TOKEN 流程

在 npm 创建只允许访问 `dsh-crwu-workbench` 的 granular token，并给予当前发布所需的写权限。然后在
GitHub 仓库中配置：

```text
Settings
└── Secrets and variables
    └── Actions
        └── New repository secret
            Name: NPM_TOKEN
            Value: <npm granular token>
```

注意：

- 本机 `npm whoami` 成功不代表 GitHub Actions 已获得 npm 权限；
- token 只能放在 GitHub secret 中，不能写入 `.npmrc`、workflow、提交记录或文档；
- token 到期或被撤销后，发布会报 `ENEEDAUTH`、401 或 403；
- npm 已宣布 granular token 直接发布将于 2027 年 1 月移除，因此这只是当前兼容方案。

### 3.3 方案 B：推荐迁移到 npm Trusted Publishing

推荐在下一次正式发布前完成 OIDC Trusted Publishing 迁移，避免长期保存发布 token。

在 npmjs.com 的 `dsh-crwu-workbench` 包设置中增加 Trusted Publisher：

| 字段 | 值 |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `mmungdong` |
| Repository | `crwu-ai` |
| Workflow filename | `release.yml` |
| Environment | 留空，除非仓库明确使用 GitHub Environment |
| Allowed action | 允许 `npm publish` |

然后修改 `.github/workflows/release.yml`：

1. 保留发布 job 的 `permissions: id-token: write`；
2. 使用 Node `>=22.14.0` 与 npm `>=11.5.1`；
3. 删除 `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`；
4. 删除“`NPM_TOKEN` 为空则退出”的检查；
5. 使用 `npm publish`。Trusted Publishing 会自动生成 provenance，`--provenance` 可不再显式传递；
6. 先完成一次成功发布，再撤销旧发布 token；不要先删 token 再配置 OIDC。

迁移后同步更新本文与 `AGENTS.md` 中关于认证方式的说明。

## 4. 版本号规则

本项目使用 semver：

- 修复、文案、兼容性调整：通常升 patch，例如 `0.0.11` → `0.0.12`；
- 明显新增、但保持兼容的功能：可升 minor，例如 `0.0.x` → `0.1.0`；
- 稳定后发生破坏性变更：按团队约定升 major。

发布版本只能用仓库脚本修改：

```bash
cd "$(git rev-parse --show-toplevel)/plugins/dsh-crwu-workbench"
npm run version:set -- "$CRWU_RELEASE_VERSION"
```

该命令会同步修改：

- `package.json`
- `package-lock.json` 根版本
- `VERSION`
- `src/host/consts.ts` 中的 `PLUGIN_VERSION`

它**不会**生成 CHANGELOG 内容。必须手工在 `CHANGELOG.md` 顶部增加：

```markdown
## package · 0.0.12 · <实际发布日期，YYYY-MM-DD>

- 描述本版用户可见变化；
- 描述兼容性、配置或安装变化；
- 如升级 DSH 依赖，写明验证过的 DSH 版本；
- 如无迁移操作，明确说明无需额外迁移。
```

日期使用实际发布日期。不要直接使用 `npm version`，因为它不知道本仓的 `VERSION`、
`PLUGIN_VERSION` 与 CHANGELOG 约束。

## 5. 标准发版流程

> **本节的版本号只定义一次**：下面的命令一律引用 `CRWU_RELEASE_VERSION`，避免文档里出现
> 上一版残留（本轮 0.0.12 的口径就是 `export CRWU_RELEASE_VERSION=0.0.12`，每一节用之前先确认它还在）。

```bash
export CRWU_RELEASE_VERSION=0.0.12   # 本次要发布的版本（唯一事实源，改这一处）
```

以下示例发布 `0.0.12`。替换版本号时，命令中的版本必须全部一致。

### 5.1 更新主分支

```bash
cd "$(git rev-parse --show-toplevel)"
git switch main
git pull --ff-only
git status --short
```

期望 `git status --short` 没有输出。若工作区已有未提交改动，先确认它们的归属；不要覆盖、丢弃或混入
无关改动。

### 5.2 修改版本与 CHANGELOG

```bash
cd plugins/dsh-crwu-workbench
npm run version:set -- "$CRWU_RELEASE_VERSION"
```

编辑 `CHANGELOG.md` 后检查：

```bash
npm run version:check
```

期望输出类似：

```text
PASS     版本一致：0.0.12（package.json / VERSION / CHANGELOG.md / src/host/consts.ts）
```

### 5.3 本地完整打包与门禁

回到仓库根目录执行：

```bash
cd "$(git rev-parse --show-toplevel)"
make plugin-pack
```

`make plugin-pack` 会按顺序：

1. 安装/确认插件依赖；
2. 交叉构建 macOS 与 Windows 的 `crwu`；
3. 装配两个平台的 `dws` 与 `ossutil`；
4. 生成并校验 `bin/manifest.json`；
5. 执行 `npm run check`；
6. 执行普通与严格 `pack:assert`；
7. 执行两层技能自洽性检查与源仓契约测试；
8. 生成 `dist/dsh-crwu-workbench-0.0.12.tgz`。

发布包应包含两个平台共六个二进制。文件总数与体积会随技能内容变化，不把某个历史数字当成固定断言；
以 `npm run pack:assert:strict` 成功、tarball 不超过脚本设定的上限、manifest 哈希完全一致为准。

再执行 npm 空跑：

```bash
cd plugins/dsh-crwu-workbench
npm publish --dry-run
```

空跑会执行 `prepublishOnly`，但不会上传。期望看到官方 registry 和 `(dry-run)`；如输出的 registry 不是
`https://registry.npmjs.org`，立即停止排查。

最后检查 Git 差异：

```bash
cd "$(git rev-parse --show-toplevel)"
git diff --check
git status --short
git diff -- plugins/dsh-crwu-workbench/package.json \
  plugins/dsh-crwu-workbench/package-lock.json \
  plugins/dsh-crwu-workbench/VERSION \
  plugins/dsh-crwu-workbench/src/host/consts.ts \
  plugins/dsh-crwu-workbench/CHANGELOG.md
```

不得提交：

- `dist/*.tgz`
- `plugins/dsh-crwu-workbench/.cache/`
- 临时截图、profile、日志
- npm token、AccessKey、API-Key、STS Token、签名 URL
- `bin/` 下未在 `bin/manifest.json` 声明的运行残留

### 5.4 提交并等待 CI

明确选择本次发布需要提交的文件，不用无审查的 `git add .`：

```bash
git add \
  plugins/dsh-crwu-workbench/package.json \
  plugins/dsh-crwu-workbench/package-lock.json \
  plugins/dsh-crwu-workbench/VERSION \
  plugins/dsh-crwu-workbench/src/host/consts.ts \
  plugins/dsh-crwu-workbench/CHANGELOG.md

git diff --cached --check
git diff --cached --stat
git commit -m "release(dsh-crwu-workbench): 0.0.12"
git push origin main
```

本版若还有其它代码、技能、配置或文档变更，先用 `git status --short` 列出，再逐个 `git add` 已审核且属于
本次发布的路径；不要为了省事把无关改动一起暂存。

如果仓库要求 PR，则将发布提交放进 PR，合并后再继续。必须确认 `main` 的 CI 成功，不能因为功能分支曾经
通过 CI 就跳过主分支结果。

### 5.5 创建发布 tag

确认当前提交就是要发布的提交：

```bash
git switch main
git pull --ff-only
git status --short
git log -1 --oneline --decorate
npm --prefix plugins/dsh-crwu-workbench run version:check
```

然后创建并推送正确前缀的 tag：

```bash
git tag plugin-v0.0.12
git push origin plugin-v0.0.12
```

不要使用：

```text
v0.0.12
0.0.12
dsh-v0.0.12
```

这些 tag 不会触发插件发布工作流。也不要把 tag 指向版本修改之前的提交。

### 5.6 观察 GitHub Actions

打开仓库 Actions 中的 `release-plugin`，确认两个 job 顺序成功：

1. `binaries`
   - `npm ci`
   - 交叉编译 `crwu`
   - 装配六个二进制
   - manifest 哈希检查
   - 上传临时 artifact
2. `publish`
   - 下载同一份 artifact
   - 校验 tag / `package.json` / `VERSION`
   - `npm run check`
   - `npm run pack:assert:strict`
   - `npm publish`

只有 publish step 成功，才能认为 npm 发布完成。

## 6. 发布后验证

### 6.1 验证 npm 元数据

```bash
npm view dsh-crwu-workbench version dist-tags time --json
npm view dsh-crwu-workbench@0.0.12 dist --json
```

确认：

- `version` 与 `dist-tags.latest` 都是新版本；
- `time` 中存在新版本；
- `dist.tarball` 指向官方 npm registry；
- `dist.integrity` 存在；
- 文件数和解包体积符合本地严格打包结果的量级。

npm CDN 或元数据可能短暂延迟。先等待并重新查询，不要立即重复发布或再创建同版本 tag。

### 6.2 用干净 DSH profile 验证真实安装路径

```bash
dsh --profile release-smoke --from-default-profile web --dump-config
dsh plugin --profile release-smoke add dsh-crwu-workbench@0.0.12
DSH_PERMISSION_MODE=danger-full-access dsh --profile release-smoke --port 3099 --no-open
```

至少验证：

- 插件能加载，侧栏出现“中瑞世联工作台”；
- 版本徽章、`ping.version` 或 `ping.rev` 显示新版本；
- Host 与 Client 协议一致，没有“宿主插件是旧构建”的提示；
- 环境页能识别当前平台和包内组件；
- 不执行真实 `audit-start`、OSS 写入等高风险动作，除非该版本明确需要受控验收。

如需要浏览器回归，按 `AGENTS.md` §7.7 使用 `install/browser-check.mjs`。

### 6.3 员工升级命令

```bash
dsh plugin --profile web add dsh-crwu-workbench@0.0.12
```

安装完成后重启对应 profile。只刷新浏览器不能替换已经运行的 Host 插件。

### 6.4 npmmirror 可见性与同步延迟（0.0.12 起）

- **npm 官方源是发布目标与事实源**；npmmirror 是加速器，**可能有同步延迟**。
- 镜像上暂时查不到新版本**不等于发布失败**：等待并稍后重新检查即可；
  **不得为了催镜像重发同一个版本**（npm 版本不可覆盖），也**不得重复创建同版本 tag**。
- 更新检查**同时读取两个源**，所以官方源已经出现更高版本时，即使镜像暂时落后也能被发现；
  安装阶段的镜像失败与回退由 **DSH Plugin Manager** 负责。
- §6.1 的镜像那两条命令**允许暂时返回 404**，官方源为准。

## 7. Dry-run 工作流

需要在 GitHub runner 上验证完整发布链路、但不上传 npm 时，可在 Actions 手工运行
`release-plugin`，保持：

```text
dry-run = true
```

该模式会构建二进制并执行发布门禁，但跳过真正的 publish。它适合验证 runner、下载源、构建工具和包形状，
不能证明 npm 发布权限有效。

不要将 `dry-run=false` 当作常规手动发布入口。正常正式发布仍使用 `plugin-v*` tag，确保版本与 Git 历史一一
对应。

## 8. 发布失败处理

### 8.1 tag 与版本不一致

症状：`tag must match the package version` 失败。

处理：

1. 不修改已推送 tag 指向来掩盖错误；
2. 确认 npm 是否尚未发布该版本；
3. 若未发布，删除错误远端 tag，修正版本提交后创建正确 tag；
4. 若 npm 已发布，不能重用版本号，必须升下一个版本。

删除错误且尚未发布的 tag：

```bash
git push origin :refs/tags/plugin-v0.0.12
git tag -d plugin-v0.0.12
```

执行前必须再次确认准确 tag 名以及 npm 上没有该版本。

### 8.2 `NPM_TOKEN` 缺失或失效

症状：工作流提示未配置 `NPM_TOKEN`，或 npm 返回 `ENEEDAUTH`、401、403。

处理：

- 当前 Token 流程：更新 GitHub Actions 的 `NPM_TOKEN` secret；
- Trusted Publishing 流程：检查 npm 上配置的用户、仓库、workflow 文件名和 allowed action 是否精确匹配；
- 不把 token 打印到日志，也不通过提交 `.npmrc` 解决。

### 8.3 `EPUBLISHCONFLICT` 或版本已存在

原因：npm 上已经存在同名同版本包。

处理：

1. 先用 `npm view dsh-crwu-workbench@<version> version` 确认；
2. 不重试同一版本；
3. 升版本、补 CHANGELOG、重新走完整发布流程。

### 8.4 二进制或 manifest 校验失败

症状：缺平台、缺工具、sha256/size 不一致，或 `bin/` 有未声明文件。

处理：

```bash
cd "$(git rev-parse --show-toplevel)"
make plugin-bin
make plugin-check
```

不要手改 `bin/manifest.json`，也不要直接修改 `bin/` 中的产物。若 `dws` 在二进制旁生成 `.dws/`、日志或
锁文件，清理运行残留后重新装配。

### 8.5 测试、类型或技能门禁失败

不要跳过门禁或在 workflow 中加 `continue-on-error`。回到源码修复失败项，重新执行：

```bash
make plugin-pack
```

修复产生了任何包内容变化，就必须使用新的版本号。

### 8.6 npm 已发布，但后续 step 失败

先查询 npm：

```bash
npm view dsh-crwu-workbench@0.0.12 version dist --json
```

如果新版本已经存在，**不要重跑 publish**。根据失败位置补做发布后验证或发一个修复版本。

## 9. 回滚与错误版本处理

npm 包版本不可覆盖。回滚的含义不是删除并重发同一版本，而是让使用者安装已知可用版本，或发布一个新修复
版本。

### 9.1 员工临时回退

```bash
dsh plugin --profile web add dsh-crwu-workbench@0.0.10
```

然后重启 profile。

### 9.2 标记问题版本

确认影响范围后，可由有 npm 权限的维护者添加弃用说明：

```bash
npm deprecate dsh-crwu-workbench@0.0.12 "存在已知问题，先临时回退到最近的已确认可用版本 0.0.11，等 0.0.13 发布后再升级到 0.0.13"
```

弃用不会从已安装机器移除该版本，也不会释放版本号。

### 9.3 修复发布

```text
0.0.12 有问题
    ↓
修复源码与测试（并补上对应的回归测试）
    ↓
发布 0.0.13（修复版本；版本号必须往前走）
    ↓
通知员工升级到 0.0.13
```

**临时回退**优先使用最近的已确认可用版本 `0.0.11`（不要无解释地退回 `0.0.10`）；
`npm deprecate` 的提示里**只能**写已经真实存在的版本（回退版本或修复版本），
并且**只有**在它确实已经发布、可以安装时才写进去 —— 本任务不执行任何 deprecate。

不要移动已经公开使用的 `plugin-v0.0.12` tag 去指向修复提交。

### 9.4 安装侧失败（与发布无关，但排障要看）

- **更新安装失败**：插件保留原版本；回滚 / 恢复由 **Plugin Manager** 负责，
  界面如实显示失败分类与诊断信息（不显示私有源地址、凭据或完整日志）。
- **安装成功但未重启**：界面持续提示「完全退出并重新打开 DeepSeek Harness」；
  `awaiting-restart` 期间禁止再次安装，避免在重启前重复改 profile。
- **官方源成功、镜像延迟**：见 §6.4 —— 等待镜像，不重发、不重复打 tag。

## 10. 公开分发提醒

当前 `package.json` 使用无 scope 包名，并设置：

```json
{
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org"
  }
}
```

这意味着任何人都可以下载 npm 包。`license: "UNLICENSED"` 限制授权使用，但不会让包变为私有。
每次发版前应确认 tarball 中没有凭据、内部 Token、临时签名 URL、测试数据或不应公开的运行日志。

## 11. 历史基线与首次引导升级（0.0.10 / 0.0.11 → 0.0.12）

> 本节里的 `0.0.10`、`0.0.11` 是**已经发布的历史事实**，不是当前可执行的发布流程；
> 当前流程见 §5（`CRWU_RELEASE_VERSION=0.0.12`）。

- npm 上 `0.0.10`、`0.0.11` 都已发布，`latest` 目前是 `0.0.11`；**自更新代码不在其中**，
  所以**首个带更新器的正式版本只能是 `0.0.12`**（同版本不可覆盖，不允许为"首发"重发 0.0.11）。
- 旧版本**不会**自动发现 0.0.12，需要手动引导升级一次：

```bash
# <profile> 用你实际在用的 DeepSeek Harness profile 名（占位符，别照抄）
dsh plugin --profile <profile> add dsh-crwu-workbench@0.0.12
```

- 装完**完全退出并重新打开** DeepSeek Harness（macOS：应用菜单 →「退出」或 **Command-Q**；关窗口不算）；
- **从 0.0.12 起**，后续稳定版本才能在界面内检查与安装；
- **不要假定所有桌面用户都用 `web` / `desktop` profile** —— 文档里一律用 `<profile>` 占位符。

### 11.1 0.0.10 历史基线

- `0.0.10` 已经发布到 npm，且曾作为 `latest`；
- 首次发布使用了本机 npm 登录，而不是 `plugin-v*` 自动发布链路；
- 当时的本地 tag 是 `v0.0.10`，不会触发当前只监听 `plugin-v*` 的 workflow；
- 不要为补历史记录再创建并推送 `plugin-v0.0.10`，否则工作流会尝试重复发布已存在版本；
- 后续版本从 `0.0.12` 起统一按本文流程发布。

## 12. 发布检查清单

### 发布前

- [ ] 改动已经完成功能测试与人工验收
- [ ] 发布内容已经完成代码审查
- [ ] 版本号按 semver 递增，npm 上尚不存在该版本
- [ ] 已运行 `npm run version:set <version>`
- [ ] `CHANGELOG.md` 已增加对应版本小节
- [ ] `npm run version:check` 通过
- [ ] `make plugin-pack` 通过
- [ ] `npm publish --dry-run` 通过
- [ ] tarball 包含两个平台六个二进制，manifest 校验通过
- [ ] `git diff --check` 通过
- [ ] 没有凭据、缓存、日志、临时 profile 或 tgz 进入提交
- [ ] 发布提交已进入 `main`
- [ ] `main` CI 通过
- [ ] npm 发布认证已配置：当前 `NPM_TOKEN`，或迁移后的 Trusted Publisher

### 发布

- [ ] tag 名为 `plugin-v<version>`
- [ ] tag 指向正确的 `main` 发布提交
- [ ] `release-plugin / binaries` 成功
- [ ] `release-plugin / publish` 成功

### 发布后

- [ ] `npm view` 显示新版本与正确 `latest`
- [ ] tarball、integrity、文件数与体积合理
- [ ] 干净 DSH profile 能从 npm 安装
- [ ] Host 与 Client 显示同一新版本
- [ ] 环境页与基础导航正常
- [ ] 已提供员工升级命令并说明需要重启 profile

## 13. 常用命令速查

```bash
# 当前 npm 最新版本
npm view dsh-crwu-workbench version

# 判断目标版本是否已经存在
npm view dsh-crwu-workbench@0.0.12 version

# 修改版本
cd plugins/dsh-crwu-workbench
npm run version:set -- "$CRWU_RELEASE_VERSION"

# 检查版本一致性
npm run version:check

# 根目录完整打包
cd "$(git rev-parse --show-toplevel)"
make plugin-pack

# npm 空跑
cd plugins/dsh-crwu-workbench
npm publish --dry-run

# 发布 tag
cd "$(git rev-parse --show-toplevel)"
git tag plugin-v0.0.12
git push origin plugin-v0.0.12

# 发布后验证
npm view dsh-crwu-workbench version dist-tags time --json

# 员工升级
dsh plugin --profile web add dsh-crwu-workbench@0.0.12
```

## 14. 权威来源

仓库内规则冲突时按以下优先级处理：

1. `plugins/dsh-crwu-workbench/AGENTS.md` 的发版门禁；
2. 仓库根 `.github/workflows/release.yml` 的实际执行逻辑；
3. 仓库根 `Makefile` 的 `plugin-*` 目标；
4. 本文；
5. README 中的命令速查。

外部规则以 npm 官方文档为准：

- Trusted Publishing：<https://docs.npmjs.com/trusted-publishers/>
- npm publish 与版本不可复用：<https://docs.npmjs.com/cli/v11/commands/npm-publish/>
- Access token 与直接发布弃用：<https://docs.npmjs.com/about-access-tokens/>

---
