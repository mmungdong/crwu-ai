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

.PHONY: build build-mac build-win fmt test clean

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
