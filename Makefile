GO ?= go
VERSION ?= dev
COMMIT ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)

BINARY := crwu
BIN_DIR := bin
BUILDINFO := github.com/mmungdong/crwu-ai/internal/buildinfo
LDFLAGS := -s -w -X $(BUILDINFO).Version=$(VERSION) -X $(BUILDINFO).Commit=$(COMMIT)

.PHONY: build test fmt clean

build:
	mkdir -p $(BIN_DIR)
	$(GO) build -trimpath -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/$(BINARY) ./cmd/crwu

test:
	$(GO) test ./...

fmt:
	$(GO) fmt ./...

clean:
	rm -rf -- "$(CURDIR)/bin"
