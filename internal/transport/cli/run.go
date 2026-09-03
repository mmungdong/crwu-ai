package cli

import (
	"encoding/json"
	"fmt"
	"io"

	"github.com/mmungdong/crwu-ai/internal/buildinfo"
)

type commandHandler func(stdout, stderr io.Writer) int

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
		printUsage(stderr)
		return 2
	}

	if args[0] == "-h" || args[0] == "--help" {
		return runHelp(stdout, stderr)
	}

	for _, command := range commandDefinitions() {
		if command.Name == args[0] {
			return command.handler(stdout, stderr)
		}
	}

	fmt.Fprintf(stderr, "unknown command %q\n\n", args[0])
	printUsage(stderr)
	return 2
}

func printUsage(w io.Writer) {
	fmt.Fprintln(w, "Usage: crwu <command>")
	fmt.Fprintln(w)
	fmt.Fprintln(w, "Commands:")
	for _, command := range commandDefinitions() {
		fmt.Fprintf(w, "  %-8s %s\n", command.Name, command.Description)
	}
}

func runHelp(stdout, _ io.Writer) int {
	printUsage(stdout)
	return 0
}

func runScheme(stdout, stderr io.Writer) int {
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
		fmt.Fprintf(stderr, "write scheme: %v\n", err)
		return 1
	}
	return 0
}

func runVersion(stdout, _ io.Writer) int {
	fmt.Fprintf(stdout, "crwu %s\n", buildinfo.String())
	return 0
}
