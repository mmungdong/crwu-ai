// Package browser opens authorization URLs with the operating system's default
// browser on macOS, Windows, and Linux.
package browser

import (
	"errors"
	"fmt"
	"net/url"
	"os/exec"
	"runtime"
)

type commandRunner func(name string, args ...string) error

type Opener struct {
	goos string
	run  commandRunner
}

func NewOpener() *Opener {
	return newOpener(runtime.GOOS, runCommand)
}

func newOpener(goos string, run commandRunner) *Opener {
	return &Opener{goos: goos, run: run}
}

func (o *Opener) Open(value string) error {
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" {
		return errors.New("authorization URL must use HTTP or HTTPS")
	}
	switch o.goos {
	case "darwin":
		return o.run("open", value)
	case "windows":
		return o.run("rundll32", "url.dll,FileProtocolHandler", value)
	case "linux", "freebsd", "openbsd", "netbsd":
		return o.run("xdg-open", value)
	default:
		return fmt.Errorf("opening a browser is not supported on %s", o.goos)
	}
}

func runCommand(name string, args ...string) error {
	command := exec.Command(name, args...)
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}
