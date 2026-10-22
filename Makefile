PLUGIN    ?= dsh-crwu-workbench
GO        ?= go
NPM       ?= npm
PYTHON    ?= python3
VERSION   ?= 0.0.1
override NPM_REGISTRY := https://registry.npmjs.org
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
# 插件**从 npm 分发**（`npm publish`，走 `.github/workflows/release.yml` 的 tag 流程）；
# `make plugin-pack` 只负责在本地打一份 tarball 供 `npm publish --dry-run` 与接收方自测。
#
# 2026-09-25 之前这里是「打包 + 上传只读 OSS + 打印安装命令」（`make plugin-dist`）。
# 那条路连同只读 Bucket 一起下掉了：员工设备的安装行为不该依赖一个远端对象，
# 而且那个地址谁都能换 —— 少一个远端数据源就少一条可被远程改写的通道。
# **发布纪律仍然有效**：同一个版本号只发一次（npm 的不可变版本号天然守住这条，别手工 `npm publish`）。
PLUGIN_DIR    := $(CURDIR)/plugins/$(PLUGIN)
# npm 包的 tarball 名跟着 `package.json` 的 name 走（不一定等于插件目录名），所以从包里取。
PLUGIN_PKG_NAME ?= $(shell node -p "require('$(PLUGIN_DIR)/package.json').name" 2>/dev/null)
PLUGIN_VERSION ?= $(shell node -p "require('$(PLUGIN_DIR)/package.json').version" 2>/dev/null)
DIST_DIR      := $(CURDIR)/dist
PLUGIN_TGZ    := $(DIST_DIR)/$(PLUGIN_PKG_NAME)-$(PLUGIN_VERSION).tgz
H3YUN_BUNDLE  := $(DIST_DIR)/crwu-h3yun-bundle-$(VERSION).zip

.PHONY: build build-mac build-win fmt test clean docs-check \
        h3yun-bundle h3yun-bundle-check \
        plugin-deps plugin-python plugin-skills plugin-dws plugin-bin plugin-bin-check plugin-check plugin-ocr-check plugin-pack plugin-clean \
        plugin-version plugin-version-set plugin-npm-login plugin-npm-whoami \
        plugin-publish-dry-run plugin-publish plugin-local-install plugin-local-verify

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

docs-check:
	node scripts/check-docs.mjs

clean:
	rm -rf -- "$(CURDIR)/$(BIN_DIR)"

# ── WorkBuddy 便携包（零安装） ────────────────────────────────────────────────
# 把 crwu 二进制（darwin-arm64 / win32-x64）与 crwu-h3yun-login / crwu-h3yun-query
# 两个技能打成一个 zip：接收方解压后把包里的提示词交给 WorkBuddy，二进制按绝对路径
# 从包内直接跑，不写 PATH、不写 ~/.workbuddy、不写 ~/.crwu。
#
# 入口文档与提示词在 scripts/h3yun-bundle/；打包脚本是 stdlib-only Python，
# 两个平台都只是**复制**已构建的二进制，因此不引入新的外部命令。
h3yun-bundle-check:
	$(PYTHON) scripts/test_build_h3yun_bundle.py

h3yun-bundle: build h3yun-bundle-check
	$(PYTHON) scripts/build_h3yun_bundle.py \
		--version "$(VERSION)" --commit "$(COMMIT)" --out "$(H3YUN_BUNDLE)"
	@echo "==> $(H3YUN_BUNDLE)"

# ── 插件目标 ────────────────────────────────────────────────────────────────

# 装依赖（`npm ci`：严格按 package-lock.json 复现）。node_modules 已存在就不重复装，
# 需要重装时 `rm -rf plugins/$(PLUGIN)/node_modules`。
$(PLUGIN_DIR)/node_modules: $(PLUGIN_DIR)/package-lock.json
	cd "$(PLUGIN_DIR)" && npm ci

plugin-deps: $(PLUGIN_DIR)/node_modules

plugin-version:
	node scripts/plugin-release.mjs info \
		--plugin-dir "$(PLUGIN_DIR)" --npm "$(NPM)" --registry "$(NPM_REGISTRY)"

plugin-version-set: plugin-deps
	@test -n "$(PLUGIN_RELEASE_VERSION)" || { echo "用法：make plugin-version-set PLUGIN_RELEASE_VERSION=x.y.z"; exit 1; }
	cd "$(PLUGIN_DIR)" && $(NPM) run version:set -- "$(PLUGIN_RELEASE_VERSION)"
	cd "$(PLUGIN_DIR)" && $(NPM) run version:check

plugin-npm-login:
	cd "$(PLUGIN_DIR)" && $(NPM) login --registry="$(NPM_REGISTRY)"

plugin-npm-whoami:
	cd "$(PLUGIN_DIR)" && $(NPM) whoami --registry="$(NPM_REGISTRY)"

# 把 plugins/common/skills/ 里的公共技能拷进包内 common/skills/（npm files 出不了包目录）。
# 员工机器上没有源目录，脚本会自己跳过，所以这条在接收方也不会失败。
plugin-skills: plugin-deps
	cd "$(PLUGIN_DIR)" && npm run skills:sync

# 把上游 `dws`（dingtalk-workspace-cli）自带的钉钉技能同步进 `skills/dws/`（vendored 层）。
# 只在开发机上有意义（要装过 dws）；普通开发/构建不需要它，`npm run check` 里的 dws:check
# 只比对已提交的 provenance，不碰上游。升级上游要审 diff：`npm run dws:sync -- --allow-version-change`。
plugin-dws: plugin-deps
	cd "$(PLUGIN_DIR)" && npm run dws:sync

# 把工作台需要的三个二进制装配进包内 `bin/<平台>/`（darwin-arm64 与 win32-x64 各一套）：
#   crwu    ← 本仓构建产物（`bin/darwin/crwu`、`bin/windows/crwu.exe`）
#   ossutil ← 阿里云官方包（URL/sha256 在 scripts/sync-binaries.mjs 里，构建时才用得到）
#   dws     ← npm 包 dingtalk-workspace-cli 的 assets（sha256 对照包内 checksums.txt）
#
# **依赖 `build`**：仓库根 `bin/` 是 gitignore 的构建产物，随时可能不在（`make clean`、换机器）；
# 少了这层依赖，`make plugin-pack` 会在装配阶段以一句「找不到本仓构建产物」收场（实测踩到）。
# 需要网络；`--check` 只校验已装配内容（CI 用不到，发布链路必须真装配）。
plugin-bin: build plugin-deps
	cd "$(PLUGIN_DIR)" && node scripts/sync-binaries.mjs

plugin-bin-check: plugin-deps
	cd "$(PLUGIN_DIR)" && node scripts/sync-binaries.mjs --check

# ── DSH 自带 Python（OCR 门禁的解释器）────────────────────────────────────────
# 门禁**不退回系统 `python3`**：员工机器与干净机器上那一份既不保证存在，也不保证带 Pillow；
# 缺了它 OCR 真实渲染的两条用例只会 skip，而 **skip 不是通过证据**（那会让整条门禁看起来通过）。
# 没有显式指定时按 DSH 自己的目录约定解析（`$DSH_HOME/dsh-runtimes/*/dependencies/python`），
# 解析/探测逻辑在 scripts/resolve-dsh-python.mjs，交付前还会再校验一次它能 `import PIL`。
# 覆盖：`make plugin-check DSH_PYTHON=<python 绝对路径>`，或导出同名环境变量。
ifndef DSH_PYTHON
DSH_PYTHON := $(shell node "$(CURDIR)/scripts/resolve-dsh-python.mjs" 2>/dev/null)
endif

# 门禁前置：拿不到（或跑不动）DSH 自带 Python 就立刻红，而不是等到门禁末尾才发现两条用例被 skip。
plugin-python:
	@test -n "$(DSH_PYTHON)" || { \
		node "$(CURDIR)/scripts/resolve-dsh-python.mjs" > /dev/null; \
		exit 1; \
	}
	@"$(DSH_PYTHON)" -c 'import sys, PIL; print("DSH 自带 Python：" + sys.version.split()[0] + "（Pillow " + PIL.__version__ + "）")' \
		|| { echo "✖ 上面这个解释器不可用（需要能 import PIL）：$(DSH_PYTHON)"; \
		     echo "  处理：用 make plugin-check DSH_PYTHON=<别的绝对路径> 覆盖，或修复 DSH 运行时。"; exit 1; }

# 完整门禁 = 版本一致 + 公共技能同步 + dws 层内容一致 + 类型 + 测试 + 构建 + 产物冒烟 + tarball 自检
#            + 技能自洽性 lint（crwu 层与公共层各一次）+ 三个源仓契约测试 + 分发守卫判定自检
#            （与 CI 同一条命令集）。dws 层是上游正文，按 `skills/README.md` 的口径豁免自洽性 lint。
#            OCR 真实渲染用 **DSH 自带 Python**（见上面的 plugin-python），不用系统 python3。
plugin-check: plugin-deps plugin-python
	cd "$(PLUGIN_DIR)" && npm run check
	cd "$(PLUGIN_DIR)" && npm run pack:assert
	# 发布严格模式：两个平台六个二进制 + manifest 必须在真实 tarball 里且逐个哈希一致。
	cd "$(PLUGIN_DIR)" && npm run pack:assert:strict
	cd "$(PLUGIN_DIR)" && python3 skills/crwu/crwu-dev-audit-skill-maintainer/scripts/kb_tool.py validate --skill-root skills/crwu
	cd "$(PLUGIN_DIR)" && python3 skills/crwu/crwu-dev-audit-skill-maintainer/scripts/kb_tool.py validate --skill-root common/skills
	# 业务层（skills/biz）自包含性同样要过一次（非 vendored 层各一次）。
	cd "$(PLUGIN_DIR)" && python3 skills/crwu/crwu-dev-audit-skill-maintainer/scripts/kb_tool.py validate --skill-root skills/biz
	# 共享能力层（skills/capabilities）：OCR 技能同样必须能作为副本独立工作。
	cd "$(PLUGIN_DIR)" && python3 skills/crwu/crwu-dev-audit-skill-maintainer/scripts/kb_tool.py validate --skill-root skills/capabilities
	# 门禁只读源码：`PYTHONDONTWRITEBYTECODE=1` 保证不在包目录留下 `__pycache__/*.pyc`
	# —— `files` 里有 `skills/crwu/`，残留会被 `pack:assert` 判成「打进了不该发布的东西」。
	cd "$(PLUGIN_DIR)" && PYTHONDONTWRITEBYTECODE=1 python3 skills/crwu/crwu-dev-audit-skill-maintainer/scripts/test_audit_skill_maintainer.py
	cd "$(PLUGIN_DIR)" && PYTHONDONTWRITEBYTECODE=1 python3 skills/crwu/crwu-audit/scripts/test_audit_multiaxis_router.py
	# 阶段一材料盘点契约（H0 隔离 / 工作版重建 / 媒体证据 / OCR 兜底清单 ocrRequired）。
	cd "$(PLUGIN_DIR)" && PYTHONDONTWRITEBYTECODE=1 python3 skills/crwu/crwu-audit/scripts/test_prepare_materials.py
	cd "$(PLUGIN_DIR)" && PYTHONDONTWRITEBYTECODE=1 python3 common/skills/crwu-dws/scripts/test_dws_source_contract.py
	# 业务层（skills/biz）：报告评估的多类型资料提取脚本契约。缺 openpyxl / python-docx / Pillow
	# 时对应用例**跳过**（那是运行时能力差异，不是脚本缺陷），缺口分支照常断言。
	cd "$(PLUGIN_DIR)" && PYTHONDONTWRITEBYTECODE=1 python3 skills/biz/crwu-biz-valuation-realestate/scripts/test_extract_files.py
	# 估值交付契约（v2）：报告数据 Schema/口径、通用工作簿生成与校验、报告渲染。
	cd "$(PLUGIN_DIR)" && PYTHONDONTWRITEBYTECODE=1 python3 skills/biz/crwu-biz-valuation-realestate/scripts/test_report_data.py
	cd "$(PLUGIN_DIR)" && PYTHONDONTWRITEBYTECODE=1 python3 skills/biz/crwu-biz-valuation-realestate/scripts/test_generic_workbook.py
	cd "$(PLUGIN_DIR)" && PYTHONDONTWRITEBYTECODE=1 python3 skills/biz/crwu-biz-valuation-realestate/scripts/test_report_render.py
	# 市场法**生产入口**：阈值全部来自知识快照、缺少任何一条都不许运行、缺失不许当 0、
	# 以及"案例少于知识要求时仍给参考结论而不是把金额清空"（design §6.1）。
	cd "$(PLUGIN_DIR)" && PYTHONDONTWRITEBYTECODE=1 python3 skills/biz/crwu-biz-valuation-realestate/scripts/test_calculate_market.py
	# 挂牌参考一次性交付：固定输入身份、四件产物、修订目录、generatedAt 冻结与只读校验。
	cd "$(PLUGIN_DIR)" && PYTHONDONTWRITEBYTECODE=1 python3 skills/biz/crwu-biz-valuation-realestate/scripts/test_listing_reference.py
	# OCR 能力：依赖清单/哈希/路径安全 + **真实 PDF 渲染**，两条都必须跑实。解释器固定用
	# DSH 自带 Python（plugin-python 已前置校验过它带 Pillow），避免在没装 python3、或装了但
	# 缺 Pillow 的机器上被 skip 掉却当作通过。
	cd "$(PLUGIN_DIR)" && PYTHONDONTWRITEBYTECODE=1 "$(DSH_PYTHON)" skills/capabilities/crwu-ocr/scripts/test_ocr_runtime.py
	cd "$(PLUGIN_DIR)" && PYTHONDONTWRITEBYTECODE=1 "$(DSH_PYTHON)" skills/capabilities/crwu-ocr/scripts/test_ocr_flow.py
	cd "$(PLUGIN_DIR)" && PYTHONDONTWRITEBYTECODE=1 "$(DSH_PYTHON)" skills/capabilities/crwu-ocr/scripts/test_ocr_bench.py

# OCR 能力的**真实渲染**门禁（`plugin-check` 里那两条的聚焦入口）：解释器自动取 DSH 自带
# Python（macOS 走系统 CoreGraphics、Windows 走随包 pypdfium2），一般不需要传参。
# 覆盖：make plugin-ocr-check DSH_PYTHON=<python 绝对路径>
plugin-ocr-check: plugin-deps plugin-python
	cd "$(PLUGIN_DIR)" && PYTHONDONTWRITEBYTECODE=1 "$(DSH_PYTHON)" skills/capabilities/crwu-ocr/scripts/test_ocr_runtime.py
	cd "$(PLUGIN_DIR)" && PYTHONDONTWRITEBYTECODE=1 "$(DSH_PYTHON)" skills/capabilities/crwu-ocr/scripts/test_ocr_flow.py
	cd "$(PLUGIN_DIR)" && PYTHONDONTWRITEBYTECODE=1 "$(DSH_PYTHON)" skills/capabilities/crwu-ocr/scripts/test_ocr_bench.py

# 打成可直接分发的 tgz（`npm publish` 的对象，也是接收方自测的输入）。
# 包内已含全部技能层（skills/crwu、skills/dws、common/skills）与两个平台的自带二进制。
#
# **先 plugin-bin 再 plugin-check**：二进制不在包里时 `pack:assert` 会断言失败，而顺序必须
# 由配方显式保证（并列 prerequisites 在 `make -j` 下会并行，门禁可能跑在装配之前）。
plugin-pack: plugin-deps
	@$(MAKE) --no-print-directory plugin-bin
	@$(MAKE) --no-print-directory plugin-check
	mkdir -p "$(DIST_DIR)"
	cd "$(PLUGIN_DIR)" && npm pack --pack-destination "$(DIST_DIR)"
	@echo "==> $(PLUGIN_TGZ)"
	@echo "    发布：走 tag（git tag plugin-v$(PLUGIN_VERSION) && git push origin plugin-v$(PLUGIN_VERSION)），"
	@echo "    由 .github/workflows/release.yml 跑 npm publish --provenance；不要手工 npm publish。"

# 正式发布仍优先使用 plugin-v* tag。以下入口用于维护者显式检查或应急手动发布。
plugin-publish-dry-run:
	node scripts/plugin-release.mjs preflight \
		--plugin-dir "$(PLUGIN_DIR)" --repo-root "$(CURDIR)" \
		--npm "$(NPM)" --registry "$(NPM_REGISTRY)" \
		--require-confirmation false --confirmation ""
	@$(MAKE) --no-print-directory plugin-bin
	cd "$(PLUGIN_DIR)" && $(NPM) publish --dry-run --registry="$(NPM_REGISTRY)"

plugin-publish:
	node scripts/plugin-release.mjs preflight \
		--plugin-dir "$(PLUGIN_DIR)" --repo-root "$(CURDIR)" \
		--npm "$(NPM)" --registry "$(NPM_REGISTRY)" \
		--require-confirmation true --confirmation "$(CONFIRM_PUBLISH)"
	@$(MAKE) --no-print-directory plugin-bin
	cd "$(PLUGIN_DIR)" && $(NPM) publish --dry-run --registry="$(NPM_REGISTRY)"
	cd "$(PLUGIN_DIR)" && $(NPM) publish --registry="$(NPM_REGISTRY)"

# 本地自测安装：现打当前代码的包 → 清干净 desktop profile → 装进去 → 校验自洽。
#
# 为什么要先「清」：profile 里上一次安装留下的 node_modules 会让缺失的 peer 看起来能解析。
# 0.0.43 在 macOS 上就是这么被掩盖的 —— 残留的 @langchain/core 落在解析不到的层级、
# zod 由另一个插件顺带带入，于是本机「能跑」，干净机器装完直接 ERR_MODULE_NOT_FOUND。
# 这里只删 node_modules（不动 package.json / lockfile / 其它插件条目），装完由
# `plugin-local-verify` 把「还有哪些包可能掩盖问题」一并提示出来。
#
# 用的是 `npm pack`，它会跑 prepack（config:check + skills:sync + dws:check + build:lib），
# 所以打进 tarball 的 lib/ 一定是当前源码构建的，而不是上一次的产物。
DSH         ?= dsh
DSH_PROFILE ?= desktop
PROFILE_DIR := $(HOME)/.dsh/profiles/$(DSH_PROFILE)

plugin-local-install: plugin-deps
	@test -n "$(HOME)" || { echo "HOME 未设置，拒绝清理 profile"; exit 1; }
	@test -d "$(PROFILE_DIR)" || { echo "profile 不存在: $(PROFILE_DIR)（不自动创建）"; exit 1; }
	mkdir -p "$(DIST_DIR)"
	cd "$(PLUGIN_DIR)" && $(NPM) pack --pack-destination "$(DIST_DIR)"
	@echo "==> tarball: $(PLUGIN_TGZ)"
	@echo "==> 清理 $(PROFILE_DIR)/node_modules（上一次安装的全部依赖副本）"
	rm -rf -- "$(PROFILE_DIR)/node_modules"
	-$(DSH) plugin --profile $(DSH_PROFILE) remove $(PLUGIN_PKG_NAME)
	$(DSH) plugin --profile $(DSH_PROFILE) add "$(PLUGIN_TGZ)"
	@$(MAKE) --no-print-directory plugin-local-verify
	@echo "==> 完成：重启 DSH 生效（--profile $(DSH_PROFILE)）"

# 只读校验：安装是否自洽（依赖、入口 import、依赖自带的必需 peer 都要能从本插件位置解析）。
plugin-local-verify:
	@cd "$(PLUGIN_DIR)" && node scripts/verify-installed.mjs "$(PROFILE_DIR)" "$(PLUGIN_PKG_NAME)"

# 插件侧的构建产物：分发包（dist/）、装配好的二进制（bin/）与它的下载缓存（.cache/）。
# `.npm-cache/` 是包内 `.npmrc` 锚定的 npm 缓存：每次 `npm pack` 都会缓存一份 ~40MB 的 tarball，
# 跑多了会累积，这里一并清掉（下次门禁会自动重建，只影响下载/打包的复用速度）。
plugin-clean:
	rm -rf -- "$(DIST_DIR)" "$(PLUGIN_DIR)/bin" "$(PLUGIN_DIR)/.cache" "$(PLUGIN_DIR)/.npm-cache"
