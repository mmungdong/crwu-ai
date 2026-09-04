package cli

import (
	"bytes"
	"strings"
	"testing"

	"github.com/mmungdong/crwu-ai/internal/buildinfo"
)

func TestRunVersionWritesBuildInformation(t *testing.T) {
	oldVersion, oldCommit := buildinfo.Version, buildinfo.Commit
	t.Cleanup(func() {
		buildinfo.Version, buildinfo.Commit = oldVersion, oldCommit
	})
	buildinfo.Version, buildinfo.Commit, buildinfo.BuildDate = "1.2.3", "abc123", "2026-09-04T02:00:00Z"

	var stdout, stderr bytes.Buffer
	code := Run([]string{"version"}, &stdout, &stderr)

	if code != 0 {
		t.Fatalf("Run() exit code = %d, want 0", code)
	}
	if got := stdout.String(); !strings.Contains(got, "crwu 1.2.3") || !strings.Contains(got, "commit    abc123") || !strings.Contains(got, "built     2026-09-04 02:00:00 UTC") {
		t.Fatalf("stdout = %q", got)
	}
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q, want empty", stderr.String())
	}
}

func TestRunUnknownCommandReturnsUsageError(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := Run([]string{"missing"}, &stdout, &stderr)

	if code != 2 {
		t.Fatalf("Run() exit code = %d, want 2", code)
	}
	if stdout.Len() != 0 {
		t.Fatalf("stdout = %q, want empty", stdout.String())
	}
	if got := stderr.String(); !strings.Contains(got, `unknown command "missing"`) || !strings.Contains(got, "Usage: crwu <command>") {
		t.Fatalf("stderr = %q, want unknown-command error and usage", got)
	}
}

func TestRunWithoutArgumentsReturnsUsageError(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := Run(nil, &stdout, &stderr)

	if code != 2 {
		t.Fatalf("Run() exit code = %d, want 2", code)
	}
	if stdout.Len() != 0 {
		t.Fatalf("stdout = %q, want empty", stdout.String())
	}
	if got := stderr.String(); !strings.Contains(got, "Usage: crwu <command>") {
		t.Fatalf("stderr = %q, want usage", got)
	}
}

func TestRunHelpWritesUsage(t *testing.T) {
	for _, arg := range []string{"help", "-h", "--help"} {
		t.Run(arg, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			code := Run([]string{arg}, &stdout, &stderr)

			if code != 0 {
				t.Fatalf("Run() exit code = %d, want 0", code)
			}
			if got := stdout.String(); !strings.Contains(got, "Usage: crwu <command>") {
				t.Fatalf("stdout = %q, want usage", got)
			}
			if stderr.Len() != 0 {
				t.Fatalf("stderr = %q, want empty", stderr.String())
			}
		})
	}
}
