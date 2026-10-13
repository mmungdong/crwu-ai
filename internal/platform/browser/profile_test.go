package browser

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// envOf 造一个只认给定键的 getenv。
func envOf(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestProfileDirPrefersEnvOverride(t *testing.T) {
	got, err := ProfileDir(envOf(map[string]string{"CRWU_BROWSER_PROFILE": "/tmp/x-profile"}))
	if err != nil {
		t.Fatalf("ProfileDir() error = %v, want nil", err)
	}
	if got != "/tmp/x-profile" {
		t.Fatalf("ProfileDir() = %q, want /tmp/x-profile", got)
	}
}

func TestProfileDirDefaultsUnderUserHome(t *testing.T) {
	got, err := ProfileDir(envOf(map[string]string{"HOME": "/tmp/fakehome"}))
	if err != nil {
		t.Fatalf("ProfileDir() error = %v, want nil", err)
	}
	want := filepath.Join("/tmp/fakehome", ".crwu", "browser", "profile")
	if got != want {
		t.Fatalf("ProfileDir() = %q, want %q", got, want)
	}
}

func TestProfileDirRejectsEmptyHome(t *testing.T) {
	// 既没有覆盖、又没有 HOME 且拿不到系统主目录时，必须是明确错误，
	// 而不是拼出一个相对的 ".crwu/browser/profile"（那会落到进程当前目录）。
	_, err := ProfileDir(envOf(map[string]string{}))
	if err == nil && os.Getenv("HOME") != "" {
		t.Skip("system home is resolvable here; covered by the injection path above")
	}
	if err == nil {
		t.Fatal("ProfileDir() = nil error with no home available")
	}
}

func TestEnsureProfileDirCreatesAndForces0700(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "profile")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("seed dir: %v", err)
	}
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatalf("seed perm: %v", err)
	}

	if err := EnsureProfileDir(dir); err != nil {
		t.Fatalf("EnsureProfileDir() error = %v, want nil", err)
	}
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o700 {
		t.Fatalf("EnsureProfileDir() left perm %o, want 700", perm)
	}
}

func TestEnsureProfileDirRejectsFileInPlaceOfDir(t *testing.T) {
	path := filepath.Join(t.TempDir(), "profile")
	if err := os.WriteFile(path, []byte("not a dir"), 0o600); err != nil {
		t.Fatalf("seed file: %v", err)
	}

	err := EnsureProfileDir(path)
	if err == nil {
		t.Fatal("EnsureProfileDir() = nil error when the path is a regular file")
	}
	if !strings.Contains(err.Error(), path) {
		t.Fatalf("EnsureProfileDir() error = %q, want it to name %q", err.Error(), path)
	}
	// 不得因为「要建目录」就把已有文件删掉。
	if _, statErr := os.Stat(path); statErr != nil {
		t.Fatalf("EnsureProfileDir() removed the existing file: %v", statErr)
	}
}
