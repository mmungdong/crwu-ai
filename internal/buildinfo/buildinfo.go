package buildinfo

import (
	"fmt"
	"runtime"
)

var (
	// Version is the semantic version, injected via -ldflags.
	Version = "0.0.1"
	// Commit is the abbreviated git commit, injected via -ldflags.
	Commit = "unknown"
	// BuildDate is the UTC build timestamp (RFC3339), injected via -ldflags.
	BuildDate = "unknown"
)

// String returns a human-readable version line.
func String() string {
	return fmt.Sprintf("%s (commit %s, built %s, %s)", Version, Commit, BuildDate, Platform())
}

// Platform describes the OS family and architecture this binary was built for.
func Platform() string {
	return fmt.Sprintf("%s/%s", osFamily(), runtime.GOARCH)
}

func osFamily() string {
	switch runtime.GOOS {
	case "darwin":
		return "macOS"
	case "windows":
		return "Windows"
	case "linux":
		return "Linux"
	default:
		return runtime.GOOS
	}
}
