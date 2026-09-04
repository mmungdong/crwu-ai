GO ?= go
VERSION ?= 0.0.1
COMMIT ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)

BINARY := crwu
BIN_DIR := bin
BUILDINFO := github.com/mmungdong/crwu-ai/internal/buildinfo
LDFLAGS := -s -w -X $(BUILDINFO).Version=$(VERSION) -X $(BUILDINFO).Commit=$(COMMIT)

.PHONY: build fmt test clean

build:
	mkdir -p $(BIN_DIR)
	$(GO) build -trimpath -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/$(BINARY) ./cmd/crwu

fmt:
	$(GO) fmt ./...

test:
	$(GO) test ./...

clean:
	rm -rf -- "$(CURDIR)/bin"
