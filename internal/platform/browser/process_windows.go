//go:build windows

package browser

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// processCommandLine returns one process's command line on Windows.
//
// The profile-lock fallback is a convenience, not the only path: our own port file
// and Chromium's `DevToolsActivePort` are tried first. When neither is available we
// would rather report "no candidate" than pull in a WMI dependency, so this uses
// `tasklist` only to answer "is the owner still alive" and yields no port.
func processCommandLine(pid int) (string, error) {
	if pid <= 0 {
		return "", fmt.Errorf("进程号不合法：%d", pid)
	}
	out, err := exec.Command("tasklist", "/FI", "PID eq "+strconv.Itoa(pid), "/FO", "CSV", "/NH").Output()
	if err != nil {
		return "", err
	}
	if !strings.Contains(string(out), strconv.Itoa(pid)) {
		return "", fmt.Errorf("进程 %d 不在运行", pid)
	}
	return "", nil
}
