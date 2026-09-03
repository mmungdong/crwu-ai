package buildinfo

import "fmt"

var (
	Version = "0.0.1"
	Commit  = "unknown"
)

func String() string {
	return fmt.Sprintf("%s (commit %s)", Version, Commit)
}
