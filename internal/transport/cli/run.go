package cli

import (
	"fmt"
	"io"

	"github.com/mmungdong/crwu-ai/internal/buildinfo"
)

const usage = `Usage: crwu <command>

Commands:
  version  Print version information
  help     Show this help
`

func Run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		printUsage(stderr)
		return 2
	}

	switch args[0] {
	case "version":
		fmt.Fprintf(stdout, "crwu %s\n", buildinfo.String())
		return 0
	case "help", "-h", "--help":
		printUsage(stdout)
		return 0
	default:
		fmt.Fprintf(stderr, "unknown command %q\n\n", args[0])
		printUsage(stderr)
		return 2
	}
}

func printUsage(w io.Writer) {
	fmt.Fprint(w, usage)
}
