package browser

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// defaultProfileRel is the profile location under the employee's home.
//
// It lives under ~/.crwu so that one employee's signed-in browser session is
// theirs alone: the profile *is* the credential, and sharing it would mean
// sharing the session.
var defaultProfileRel = filepath.Join(".crwu", "browser", "profile")

// ProfileDir resolves where the browser profile lives.
//
// HOME is read through the injected getenv (falling back to os.UserHomeDir) so
// that the resolution is testable without touching the real home directory.
func ProfileDir(getenv func(string) string) (string, error) {
	if getenv == nil {
		getenv = func(string) string { return "" }
	}
	if override := strings.TrimSpace(getenv("CRWU_BROWSER_PROFILE")); override != "" {
		// 覆盖值也必须是绝对路径：相对路径会跟着调用方的 cwd 走，把凭据目录
		// 悄悄落到一个没人预期的地方。
		if !filepath.IsAbs(override) {
			return "", fmt.Errorf("CRWU_BROWSER_PROFILE 必须是绝对路径：%s", override)
		}
		return override, nil
	}

	home := strings.TrimSpace(getenv("HOME"))
	if home == "" {
		resolved, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("无法确定用户主目录：%w", err)
		}
		home = strings.TrimSpace(resolved)
	}
	if home == "" {
		// 绝不退化成相对路径：那会把凭据写到进程当前目录里。
		return "", errors.New("用户主目录为空：无法确定浏览器 profile 位置")
	}
	return filepath.Join(home, defaultProfileRel), nil
}

// EnsureProfileDir creates the profile directory with owner-only permissions and
// corrects permissions on one that already exists.
//
// 0700 is not cosmetic: the directory holds the employee's live session cookies
// in cleartext, because a browser profile cannot be encrypted in place.
func EnsureProfileDir(dir string) error {
	if strings.TrimSpace(dir) == "" {
		return errors.New("profile 目录为空")
	}
	if info, err := os.Stat(dir); err == nil && !info.IsDir() {
		return fmt.Errorf("profile 路径已被一个普通文件占用：%s", dir)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("创建 profile 目录失败：%w", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return fmt.Errorf("设置 profile 目录权限失败：%w", err)
	}
	return nil
}
