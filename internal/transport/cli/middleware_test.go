package cli

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/mmungdong/crwu-ai/internal/app/h3yunweb"
)

func TestRenewalMiddlewareExpiredSessionGuidesRelogin(t *testing.T) {
	web := &fakeWeb{ensureErr: errors.New("H3Yun session expired; run `crwu h3yun session login` to re-scan and re-bind")}
	code, _, stderr := runCLI(depsWith(nil, web), "h3yun", "apps", "list")
	if code == 0 || !strings.Contains(stderr, "session login") {
		t.Fatalf("exit=%d stderr=%q", code, stderr)
	}
	if web.renewals != 1 {
		t.Fatalf("EnsureFresh calls = %d, want 1", web.renewals)
	}
}

func TestRenewalMiddlewareSkipsSessionCommands(t *testing.T) {
	web := &fakeWeb{session: h3yunweb.Session{EngineCode: "e", UserID: "u", ExpiresAt: time.Now().Add(time.Hour)}}
	code, _, stderr := runCLI(depsWith(nil, web), "h3yun", "session", "status")
	if code != 0 {
		t.Fatalf("exit=%d stderr=%q", code, stderr)
	}
	if web.renewals != 0 {
		t.Fatalf("EnsureFresh calls = %d, want 0 for session commands", web.renewals)
	}
}
