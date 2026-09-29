package scanlogin

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func sessionJWT(engine, user string, exp int64) string {
	payload, _ := json.Marshal(map[string]any{
		"enginecode": engine,
		"userid":     user,
		"exp":        exp,
		"iat":        exp - 3600,
	})
	return "header." + base64.RawURLEncoding.EncodeToString(payload) + ".sig"
}

func TestValidSessionTokenAcceptsFutureSession(t *testing.T) {
	token := sessionJWT("eng-1", "u1", time.Now().Add(time.Hour).Unix())
	if !validSessionToken(token) {
		t.Fatal("validSessionToken() = false, want true for a future session")
	}
}

func TestValidSessionTokenRejectsJunkAndExpired(t *testing.T) {
	if validSessionToken("not-a-jwt") {
		t.Fatal("validSessionToken() = true for junk")
	}
	if validSessionToken("a.b") {
		t.Fatal("validSessionToken() = true for two segments")
	}
	expired := sessionJWT("eng-1", "u1", time.Now().Add(-time.Hour).Unix())
	if validSessionToken(expired) {
		t.Fatal("validSessionToken() = true for an expired session")
	}
	missing := sessionJWT("", "u1", time.Now().Add(time.Hour).Unix())
	if validSessionToken(missing) {
		t.Fatal("validSessionToken() = true without an engine code")
	}
}

func TestCookieValueRegex(t *testing.T) {
	match := cookieValueRegex.FindStringSubmatch("a=1; h3_token=eyJ0eXAiOiJKV1Q; other=2")
	if match == nil || !strings.HasPrefix(match[1], "eyJ") {
		t.Fatalf("regex did not extract h3_token: %#v", match)
	}
}

func TestCreateTempProfileFallsBackToUserCacheWhenTempDenied(t *testing.T) {
	var roots []string
	var createdRoot string
	makeTemp := func(root, pattern string) (string, error) {
		roots = append(roots, root+"/"+pattern)
		if len(roots) == 1 {
			return "", fmt.Errorf("mkdir: %w", os.ErrPermission)
		}
		return filepath.Join(root, "crwu-scan-123"), nil
	}
	makeDirAll := func(root string, mode os.FileMode) error {
		createdRoot = root
		if mode != 0o700 {
			t.Fatalf("fallback root mode = %o, want 0700", mode)
		}
		return nil
	}

	profile, err := createTempProfile("C:\\Users\\51019\\AppData\\Local\\Temp", "C:\\Users\\51019\\AppData\\Local", makeTemp, makeDirAll)
	if err != nil {
		t.Fatalf("createTempProfile() error = %v", err)
	}
	wantRoot := filepath.Join("C:\\Users\\51019\\AppData\\Local", "crwu", "scan-tmp")
	if createdRoot != wantRoot {
		t.Fatalf("fallback root = %q, want %q", createdRoot, wantRoot)
	}
	if profile != filepath.Join(wantRoot, "crwu-scan-123") {
		t.Fatalf("profile = %q, want it under fallback root", profile)
	}
	if len(roots) != 2 {
		t.Fatalf("MkdirTemp attempts = %d, want 2", len(roots))
	}
}

func TestCreateTempProfileDoesNotFallbackForOtherErrors(t *testing.T) {
	calledFallback := false
	wantErr := errors.New("disk full")
	_, err := createTempProfile("C:\\Temp", "C:\\Users\\51019\\AppData\\Local", func(string, string) (string, error) {
		return "", wantErr
	}, func(string, os.FileMode) error {
		calledFallback = true
		return nil
	})
	if !errors.Is(err, wantErr) {
		t.Fatalf("createTempProfile() error = %v, want %v", err, wantErr)
	}
	if calledFallback {
		t.Fatal("non-permission failure unexpectedly triggered fallback")
	}
}
