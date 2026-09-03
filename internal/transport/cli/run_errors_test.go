package cli

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) {
	return 0, errors.New("write failed")
}

func TestCommandsRejectUnexpectedArguments(t *testing.T) {
	for _, name := range []string{"help", "scheme", "version"} {
		t.Run(name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			code := Run([]string{name, "extra"}, &stdout, &stderr)

			if code != 2 {
				t.Fatalf("Run() exit code = %d, want 2", code)
			}
			if stdout.Len() != 0 {
				t.Fatalf("stdout = %q, want empty", stdout.String())
			}
			if got, want := stderr.String(), "command \""+name+"\" does not accept arguments"; !strings.Contains(got, want) {
				t.Fatalf("stderr = %q, want message containing %q", got, want)
			}
		})
	}
}

func TestCommandsReportOutputFailures(t *testing.T) {
	for _, name := range []string{"help", "scheme", "version"} {
		t.Run(name, func(t *testing.T) {
			var stderr bytes.Buffer
			code := Run([]string{name}, failingWriter{}, &stderr)

			if code != 1 {
				t.Fatalf("Run() exit code = %d, want 1", code)
			}
			if got, want := stderr.String(), "write "+name+" output: write failed"; !strings.Contains(got, want) {
				t.Fatalf("stderr = %q, want message containing %q", got, want)
			}
		})
	}
}
