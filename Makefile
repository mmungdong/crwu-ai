GO ?= go
VERSION ?= 0.0.1
COMMIT ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)

CLI_BINARY := crwu
SERVER_BINARY := crwu-server
BIN_DIR := bin
BUILDINFO := github.com/mmungdong/crwu-ai/internal/buildinfo
LDFLAGS := -s -w -X $(BUILDINFO).Version=$(VERSION) -X $(BUILDINFO).Commit=$(COMMIT)

.PHONY: build build-cli build-server test fmt clean

build: build-cli build-server

build-cli:
	mkdir -p $(BIN_DIR)
	$(GO) build -trimpath -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/$(CLI_BINARY) ./cmd/crwu

build-server:
	mkdir -p $(BIN_DIR)
	$(GO) build -trimpath -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/$(SERVER_BINARY) ./cmd/crwu-server

test:
	$(GO) test ./...

fmt:
	$(GO) fmt ./...

clean:
	rm -rf -- "$(CURDIR)/bin"
