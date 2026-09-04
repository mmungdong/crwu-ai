package buildinfo

import (
	"strings"
	"testing"
)

func TestString(t *testing.T) {
	oldVersion, oldCommit, oldDate := Version, Commit, BuildDate
	t.Cleanup(func() {
		Version, Commit, BuildDate = oldVersion, oldCommit, oldDate
	})

	Version, Commit, BuildDate = "1.2.3", "abc123", "2026-09-04T02:00:00Z"

	got := String()
	for _, want := range []string{"1.2.3", "commit abc123", "built 2026-09-04T02:00:00Z"} {
		if !strings.Contains(got, want) {
			t.Fatalf("String() = %q, want it to contain %q", got, want)
		}
	}
	if !strings.Contains(got, "/") {
		t.Fatalf("String() = %q, want a platform family/arch pair", got)
	}
}

func TestPrettyString(t *testing.T) {
	oldVersion, oldCommit, oldDate := Version, Commit, BuildDate
	t.Cleanup(func() {
		Version, Commit, BuildDate = oldVersion, oldCommit, oldDate
	})

	Version, Commit, BuildDate = "1.2.3", "abc123", "2026-09-04T02:00:00Z"

	got := PrettyString()
	for _, want := range []string{"crwu 1.2.3", "commit    abc123", "built     2026-09-04 02:00:00 UTC", "platform  "} {
		if !strings.Contains(got, want) {
			t.Fatalf("PrettyString() = %q, want it to contain %q", got, want)
		}
	}
}
