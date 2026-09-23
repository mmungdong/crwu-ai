GO        ?= go
VERSION   ?= 0.0.1
COMMIT    ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
BUILD_DATE ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

BINARY    := crwu
BIN_DIR   := bin

BUILDINFO := github.com/mmungdong/crwu-ai/internal/buildinfo
LDFLAGS   := -s -w \
	-X $(BUILDINFO).Version=$(VERSION) \
	-X $(BUILDINFO).Commit=$(COMMIT) \
	-X $(BUILDINFO).BuildDate=$(BUILD_DATE)

# `make build`（默认目标）在 bin/ 下按平台子目录分别产出两种二进制：
#   bin/darwin/crwu       macOS    —— 架构默认跟随构建机（本机 arm64），可用 DARWIN_ARCH 覆盖
#   bin/windows/crwu.exe  Windows  —— 架构默认 amd64，可用 WINDOWS_ARCH 覆盖
# macOS 构建需要 CGO（keyring 走系统钥匙串）；Windows 为纯 Go 交叉编译。
DARWIN_ARCH  ?= $(shell $(GO) env GOARCH)
WINDOWS_ARCH ?= amd64

# ── DSH 插件：plugins/dsh-crwu-workbench ──────────────────────────────
# 插件以 tarball 分发给员工，所以「打包 + 上传 OSS + 打印安装命令」都在这里，
# 让 Go CLI 与插件两种形态共用一条出口：`make plugin-dist`。
#
# **发布纪律：同一个版本号只发一次**（用户 2026-09-21 定的）。分发包 URL 就是
# `<包名>-<版本>.tgz`，覆盖同版本对象会让「同一版本号、两份内容」—— 员工之间装的不是同一份，
# 版本号也不再能用来定位问题。所以 `plugin-dist` 上传前会先只读查远端：内容一致就跳过（幂等）、
# 不一致就拒绝并让你升版本号，判断逻辑在 scripts/dist-plugin.mjs（可 `PLUGIN_DIST_DRY_RUN=1` 空跑）。
PLUGIN        ?= dsh-crwu-workbench
PLUGIN_DIR    := $(CURDIR)/plugins/$(PLUGIN)
# npm 包的 tarball 名跟着 `package.json` 的 name 走（不一定等于插件目录名），所以从包里取。
PLUGIN_PKG_NAME ?= $(shell node -p "require('$(PLUGIN_DIR)/package.json').name" 2>/dev/null)
PLUGIN_VERSION ?= $(shell node -p "require('$(PLUGIN_DIR)/package.json').version" 2>/dev/null)
DIST_DIR      := $(CURDIR)/dist
PLUGIN_TGZ    := $(DIST_DIR)/$(PLUGIN_PKG_NAME)-$(PLUGIN_VERSION).tgz

# 开发运行、TGZ 内配置与分发地址共用这一份 YAML。
PLUGIN_CONFIG ?= $(PLUGIN_DIR)/config/crwu-workbench.yml

# 技能装到非 DSH 宿主时用：`make skills-install AGENT_DIR=~/.agents/skills`。
# 收哪些技能只由目录布局决定：**任何含 SKILL.md 的目录都算一个技能**，不管它在哪一层
# （插件层 `plugins/<插件>/skills/<层>/<技能>/`、公共层 `plugins/common/skills/<技能>/`）。
# 层目录自己（`skills/crwu`、`skills/dws`）没有 SKILL.md，因此不会被当成技能；不需要名单文件。
SKILL_DIRS    := $(shell find plugins -name SKILL.md -type f 2>/dev/null | sed 's|/SKILL.md$$||' | sort)

.PHONY: build build-mac build-win fmt test clean \
        plugin-deps plugin-skills plugin-dws plugin-check plugin-pack plugin-dist plugin-clean \
        skills-install

build: build-mac build-win

build-mac:
	mkdir -p $(BIN_DIR)/darwin
	CGO_ENABLED=1 GOOS=darwin GOARCH=$(DARWIN_ARCH) $(GO) build -trimpath \
		-ldflags "$(LDFLAGS)" -o $(BIN_DIR)/darwin/$(BINARY) ./cmd/crwu

build-win:
	mkdir -p $(BIN_DIR)/windows
	CGO_ENABLED=0 GOOS=windows GOARCH=$(WINDOWS_ARCH) $(GO) build -trimpath \
		-ldflags "$(LDFLAGS)" -o $(BIN_DIR)/windows/$(BINARY).exe ./cmd/crwu

fmt:
	$(GO) fmt ./...

test:
	$(GO) test ./...

clean:
	rm -rf -- "$(CURDIR)/$(BIN_DIR)"

# ── 插件目标 ────────────────────────────────────────────────────────────────

# 装依赖（`npm ci`：严格按 package-lock.json 复现）。node_modules 已存在就不重复装，
# 需要重装时 `rm -rf plugins/$(PLUGIN)/node_modules`。
$(PLUGIN_DIR)/node_modules: $(PLUGIN_DIR)/package-lock.json
	cd "$(PLUGIN_DIR)" && npm ci

plugin-deps: $(PLUGIN_DIR)/node_modules

# 把 plugins/common/skills/ 里的公共技能拷进包内 common/skills/（npm files 出不了包目录）。
# 员工机器上没有源目录，脚本会自己跳过，所以这条在接收方也不会失败。
plugin-skills: plugin-deps
	cd "$(PLUGIN_DIR)" && npm run skills:sync

# 把上游 `dws`（dingtalk-workspace-cli）自带的钉钉技能同步进 `skills/dws/`（vendored 层）。
# 只在开发机上有意义（要装过 dws）；普通开发/构建不需要它，`npm run check` 里的 dws:check
# 只比对已提交的 provenance，不碰上游。升级上游要审 diff：`npm run dws:sync -- --allow-version-change`。
plugin-dws: plugin-deps
	cd "$(PLUGIN_DIR)" && npm run dws:sync

# 完整门禁 = 版本一致 + 公共技能同步 + dws 层内容一致 + 类型 + 测试 + 构建 + 产物冒烟 + tarball 自检
#            + 技能自洽性 lint（crwu 层与公共层各一次）+ 三个源仓契约测试 + 分发守卫判定自检
#            （与 CI 同一条命令集）。dws 层是上游正文，按 `skills/README.md` 的口径豁免自洽性 lint。
plugin-check: plugin-deps
	cd "$(PLUGIN_DIR)" && npm run check
	cd "$(PLUGIN_DIR)" && npm run pack:assert
	cd "$(PLUGIN_DIR)" && python3 skills/crwu/crwu-dev-audit-skill-maintainer/scripts/kb_tool.py validate --skill-root skills/crwu
	cd "$(PLUGIN_DIR)" && python3 skills/crwu/crwu-dev-audit-skill-maintainer/scripts/kb_tool.py validate --skill-root common/skills
	cd "$(PLUGIN_DIR)" && python3 skills/crwu/crwu-dev-audit-skill-maintainer/scripts/test_audit_skill_maintainer.py
	cd "$(PLUGIN_DIR)" && python3 skills/crwu/crwu-audit/scripts/test_audit_multiaxis_router.py
	cd "$(PLUGIN_DIR)" && python3 common/skills/crwu-dws/scripts/test_dws_source_contract.py
	node "$(CURDIR)/scripts/dist-plugin.mjs" --self-test

# 打成可直接分发的 tgz。包内已含全部技能层（skills/crwu、skills/dws、common/skills），
# 员工装完即得全部技能。
plugin-pack: plugin-deps
	mkdir -p "$(DIST_DIR)"
	cd "$(PLUGIN_DIR)" && npm pack --pack-destination "$(DIST_DIR)"
	@echo "==> $(PLUGIN_TGZ)"

# 上传到 OSS 静态站点并打印员工侧安装命令。
#
# 依赖 `plugin-check`：发出去的东西不能是红的。上传本身由 scripts/dist-plugin.mjs 做，
# 它守着「同版本只发一次」——远端已有同版本且内容一致 → 跳过；内容不一致 → **拒绝上传**
# 并提示升版本号（详见该脚本头部）。空跑：`PLUGIN_DIST_DRY_RUN=1 make plugin-dist`。
plugin-dist: plugin-check
	@$(MAKE) --no-print-directory plugin-pack
	node scripts/dist-plugin.mjs \
		--tgz "$(PLUGIN_TGZ)" \
		--config "$(PLUGIN_CONFIG)" \
		$(if $(PLUGIN_DIST_DRY_RUN),--dry-run)

plugin-clean:
	rm -rf -- "$(DIST_DIR)"

# 把仓库里的全部技能装进任意宿主的 skills 目录（非 DSH 宿主，例如 codex / workbuddy）。
# 同名覆盖：先删后拷，保证不带旧文件。
skills-install:
	@test -n "$(AGENT_DIR)" || { echo "用法：make skills-install AGENT_DIR=<skills 根目录>"; exit 1; }
	@test -n "$(SKILL_DIRS)" || { echo "没有找到任何技能目录（任何含 SKILL.md 的目录）"; exit 1; }
	@mkdir -p "$(AGENT_DIR)"
	@for dir in $(SKILL_DIRS); do \
		name=$$(basename "$$dir"); \
		rm -rf "$(AGENT_DIR)/$$name"; \
		cp -R "$$dir" "$(AGENT_DIR)/$$name"; \
	done
	@echo "==> 已装 $(words $(SKILL_DIRS)) 个技能到 $(AGENT_DIR)"
	@ls -1 "$(AGENT_DIR)"
