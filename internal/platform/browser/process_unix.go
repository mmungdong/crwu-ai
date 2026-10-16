//go:build !windows

package browser

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// processCommandLine returns one process's command line.
//
// It exists for exactly one job: recovering the debug port of a browser that still
// holds the profile lock after our own port file is gone. `ps` is part of POSIX and
// present on every platform this build targets; Windows uses the file-based fallback
// in process_windows.go.
func processCommandLine(pid int) (string, error) {
	if pid <= 0 {
		return "", fmt.Errorf("进程号不合法：%d", pid)
	}
	out, err := exec.Command("ps", "-o", "command=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return "", err
	}
	line := strings.TrimSpace(string(out))
	if line == "" {
		return "", fmt.Errorf("进程 %d 不在运行", pid)
	}
	return line, nil
}
