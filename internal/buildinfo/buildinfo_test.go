package buildinfo

import "testing"

func TestString(t *testing.T) {
	oldVersion, oldCommit := Version, Commit
	t.Cleanup(func() {
		Version, Commit = oldVersion, oldCommit
	})

	Version, Commit = "1.2.3", "abc123"

	if got, want := String(), "1.2.3 (commit abc123)"; got != want {
		t.Fatalf("String() = %q, want %q", got, want)
	}
}
