# dsh-crwu-workbench 发布手册

本包发布到 npm 官方 registry。正式发布的首选路径是 `plugin-v<version>` tag 触发
`.github/workflows/release.yml`；本机发布只用于维护者明确选择的应急场景。

## 先查看版本

在仓库根目录运行：

```bash
make plugin-version
```

输出包括包名、本地版本、npm `latest` 和建议的下一个 patch 版本。包目录可在 Makefile 顶部通过
`PLUGIN ?= dsh-crwu-workbench` 设置，也可在命令行临时覆盖：

```bash
make plugin-version PLUGIN=<plugin-directory>
```

不要把本文示例中的版本当成当前版本；每次都以命令输出为准。

## 设置版本

```bash
make plugin-version-set PLUGIN_RELEASE_VERSION=<version>
```

该目标调用插件的 `version:set`，同步 `package.json`、`package-lock.json`、`VERSION` 和 Host 版本常量，
随后立即执行 `version:check`。它不会代写 `CHANGELOG.md`；请在插件 changelog 顶部增加同版本小节后再复查。

版本必须遵循 semver，且高于 npm 已发布的最新版本。同一 npm 版本不可覆盖或复用。

## 标准发布：tag + CI

1. 完成功能验证和代码审查。
2. 用 `make plugin-version` 确认本地版本、npm 最新版本和建议版本。
3. 用 `make plugin-version-set PLUGIN_RELEASE_VERSION=<version>` 设置版本并更新 changelog。
4. 从仓库根目录运行 `make plugin-pack`。它会构建并装配两个平台的六个二进制，执行完整门禁、严格
   tarball 校验和 manifest 哈希校验。
5. 确认 `git diff --check`、`git status --short` 和 CI 均符合预期，将发布提交合入 `main`。
6. 在发布提交上创建并推送 `plugin-v<version>` tag。
7. 等待 `release-plugin` 工作流完成，再用 `make plugin-version` 或 `npm view` 核对 npm `latest`。

`v*` tag 留给 Go CLI；插件只能使用 `plugin-v*`。tag 必须指向已经合入并通过 CI 的发布提交。

## npm 身份检查

本机 dry-run 或应急发布前：

```bash
make plugin-npm-whoami
```

未登录时由维护者本人执行：

```bash
make plugin-npm-login
```

凭据只进入 npm 自己的认证流程，不写入仓库、日志或文档。登录账号必须拥有目标包发布权限。

## 本机 dry-run

```bash
make plugin-publish-dry-run
```

该目标会先检查：

- Git 工作树为空；
- npm 已登录；
- 本地版本高于 npm `latest`；
- Makefile registry 与包内 `publishConfig.registry` 均固定为 `https://registry.npmjs.org`。

预检通过后才构建/装配二进制并执行 `npm publish --dry-run`。dry-run 不上传包，但会运行 npm 的
`prepublishOnly` 和真实 tarball 检查。

## 应急手动发布

标准 tag 工作流不可用且维护者明确决定本机发布时，先完整运行 dry-run，再用包名和版本做精确确认：

```bash
make plugin-publish \
  CONFIRM_PUBLISH=dsh-crwu-workbench@<version>
```

该目标再次执行全部预检、重新 dry-run，最后才运行真实 `npm publish`。确认值必须与实际
`<package-name>@<local-version>` 完全一致；工作树不干净、未登录或版本未递增都会阻止发布。

不要在自动化或普通开发验证中调用 `make plugin-publish`。不要为失败的已发布版本重用版本号；修复后升新版本。

## 发布后验收

```bash
make plugin-version
npm view dsh-crwu-workbench version dist-tags time --json
```

还需确认：

- npm `latest` 是新版本；
- tarball 文件数和体积合理，两个平台六个二进制及 manifest 哈希一致；
- 干净 DSH profile 能从 npm 安装并加载插件；
- Host 与 Client 显示同一版本，环境页和基础导航正常。

## 事实源

发生冲突时按以下顺序判断：

1. `.github/workflows/release.yml` 的真实 CI 行为；
2. 根目录 Makefile 的 `plugin-*` 目标；
3. 插件 `package.json` 的 scripts 与 publish 配置；
4. 本手册。
