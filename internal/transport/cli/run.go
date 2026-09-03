package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/mmungdong/crwu-ai/internal/buildinfo"
)

type commandHandler func(args []string, stdout, stderr io.Writer) int

type commandDefinition struct {
	Name        string           `json:"name"`
	Description string           `json:"description"`
	Usage       string           `json:"usage"`
	Examples    []commandExample `json:"examples"`
	handler     commandHandler
}

type commandExample struct {
	Description string `json:"description"`
	Command     string `json:"command"`
}

func commandDefinitions() []commandDefinition {
	return []commandDefinition{
		{
			Name:        "help",
			Description: "Show available commands and usage information.",
			Usage:       "crwu help",
			Examples: []commandExample{
				{
					Description: "Show command help.",
					Command:     "crwu help",
				},
			},
			handler: runHelp,
		},
		{
			Name:        "scheme",
			Description: "Print the machine-readable command catalog for AI clients.",
			Usage:       "crwu scheme",
			Examples: []commandExample{
				{
					Description: "Inspect all supported commands and examples.",
					Command:     "crwu scheme",
				},
			},
			handler: runScheme,
		},
		{
			Name:        "version",
			Description: "Show the CLI version and build commit.",
			Usage:       "crwu version",
			Examples: []commandExample{
				{
					Description: "Show the installed crwu version.",
					Command:     "crwu version",
				},
			},
			handler: runVersion,
		},
	}
}

func Run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		_ = writeUsage(stderr)
		return 2
	}

	if args[0] == "-h" || args[0] == "--help" {
		return runHelp(args[1:], stdout, stderr)
	}

	for _, command := range commandDefinitions() {
		if command.Name == args[0] {
			return command.handler(args[1:], stdout, stderr)
		}
	}

	fmt.Fprintf(stderr, "unknown command %q\n\n", args[0])
	_ = writeUsage(stderr)
	return 2
}

func usageText() string {
	var text strings.Builder
	text.WriteString("Usage: crwu <command>\n\nCommands:\n")
	for _, command := range commandDefinitions() {
		fmt.Fprintf(&text, "  %-8s %s\n", command.Name, command.Description)
	}
	return text.String()
}

func writeUsage(w io.Writer) error {
	_, err := io.WriteString(w, usageText())
	return err
}

func runHelp(args []string, stdout, stderr io.Writer) int {
	if code, rejected := rejectArguments("help", args, stderr); rejected {
		return code
	}
	if err := writeUsage(stdout); err != nil {
		return reportOutputError("help", err, stderr)
	}
	return 0
}

func runScheme(args []string, stdout, stderr io.Writer) int {
	if code, rejected := rejectArguments("scheme", args, stderr); rejected {
		return code
	}

	document := struct {
		Version  string              `json:"version"`
		Commands []commandDefinition `json:"commands"`
	}{
		Version:  buildinfo.Version,
		Commands: commandDefinitions(),
	}

	encoder := json.NewEncoder(stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(document); err != nil {
		return reportOutputError("scheme", err, stderr)
	}
	return 0
}

func runVersion(args []string, stdout, stderr io.Writer) int {
	if code, rejected := rejectArguments("version", args, stderr); rejected {
		return code
	}
	if _, err := fmt.Fprintf(stdout, "crwu %s\n", buildinfo.String()); err != nil {
		return reportOutputError("version", err, stderr)
	}
	return 0
}

func rejectArguments(name string, args []string, stderr io.Writer) (int, bool) {
	if len(args) == 0 {
		return 0, false
	}
	fmt.Fprintf(stderr, "command %q does not accept arguments\n", name)
	return 2, true
}

func reportOutputError(name string, err error, stderr io.Writer) int {
	fmt.Fprintf(stderr, "write %s output: %v\n", name, err)
	return 1
}
