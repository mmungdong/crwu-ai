package buildinfo

import "fmt"

var (
	Version = "dev"
	Commit  = "unknown"
)

func String() string {
	return fmt.Sprintf("%s (commit %s)", Version, Commit)
}
