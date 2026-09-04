package buildinfo

import (
	"fmt"
	"runtime"
	"strings"
	"time"
)

var (
	// Version is the semantic version, injected via -ldflags.
	Version = "0.0.1"
	// Commit is the abbreviated git commit, injected via -ldflags.
	Commit = "unknown"
	// BuildDate is the UTC build timestamp (RFC3339), injected via -ldflags.
	BuildDate = "unknown"
)

// String returns a compact single-line version summary.
func String() string {
	return fmt.Sprintf("%s (commit %s, built %s, %s)", Version, Commit, BuildDate, Platform())
}

// PrettyString returns a labeled, human-friendly version block. The first
// line keeps the conventional "name version" form so simple parsers keep
// working.
func PrettyString() string {
	var text strings.Builder
	fmt.Fprintf(&text, "crwu %s — CRWU Agent Harness\n", Version)
	fmt.Fprintf(&text, "  commit    %s\n", Commit)
	fmt.Fprintf(&text, "  built     %s\n", prettyDate())
	fmt.Fprintf(&text, "  platform  %s", Platform())
	return text.String()
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

// prettyDate renders BuildDate as "2006-01-02 15:04:05 UTC" when it parses as
// RFC3339, and falls back to the raw value otherwise.
func prettyDate() string {
	parsed, err := time.Parse(time.RFC3339, BuildDate)
	if err != nil {
		return BuildDate
	}
	return parsed.UTC().Format("2006-01-02 15:04:05 UTC")
}
