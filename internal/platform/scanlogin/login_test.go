package scanlogin

import (
	"encoding/base64"
	"encoding/json"
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
