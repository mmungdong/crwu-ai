// Package cli implements the crwu command line with cobra, following the
// docker/k8s convention: a nested command tree, per-command help and examples,
// and a machine-readable catalog in `crwu scheme`.
package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/mmungdong/crwu-ai/internal/buildinfo"
)

// Dependencies are the application services injected into the CLI.
type Dependencies struct {
	H3YunOps H3YunOpsService
	H3YunWeb H3YunWebService
	Getenv   func(string) string
}

// Run executes the CLI with the given arguments and writers.
func Run(args []string, stdout, stderr io.Writer) int {
	return RunWithDependencies(args, stdout, stderr, envDependencies(os.Getenv))
}

// RunWithDependencies executes the CLI using application services assembled by
// the process entry point.
func RunWithDependencies(args []string, stdout, stderr io.Writer, configured Dependencies) int {
	root := newRootCommand(configured)
	root.SetOut(stdout)
	root.SetErr(stderr)
	root.SetArgs(args)
	if err := root.Execute(); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}

func envDependencies(getenv func(string) string) Dependencies {
	if getenv == nil {
		getenv = func(string) string { return "" }
	}
	return Dependencies{
		H3YunOps: envH3YunOps(getenv),
		H3YunWeb: envH3YunWeb(getenv),
		Getenv:   getenv,
	}
}

func newRootCommand(deps Dependencies) *cobra.Command {
	root := &cobra.Command{
		Use:           "crwu",
		Short:         "CRWU Agent Harness — connect AI hosts to enterprise systems",
		Long:          "crwu gives AI hosts a stable, auditable way to reach enterprise systems as the right employee.",
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	root.CompletionOptions.DisableDefaultCmd = true

	examples := map[string][]schemeExample{}

	version := newVersionCommand()
	addExamples(examples, "version", "Show the crwu version.", "crwu version")
	root.AddCommand(version)

	root.AddCommand(newSchemeCommand(root, examples))

	root.AddCommand(newH3YunCommand(deps, examples))
	return root
}

func writeJSON(out io.Writer, payload any) error {
	return json.NewEncoder(out).Encode(payload)
}

func newVersionCommand() *cobra.Command {
	return &cobra.Command{
		Use:     "version",
		Short:   "Show the CLI version, commit, build time, and platform.",
		Example: "  crwu version",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			_, err := fmt.Fprintln(cmd.OutOrStdout(), buildinfo.PrettyString())
			return err
		},
	}
}

// schemeCommand is one entry of the machine-readable catalog.
type schemeCommand struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Usage       string          `json:"usage"`
	Examples    []schemeExample `json:"examples"`
}

type schemeExample struct {
	Description string `json:"description"`
	Command     string `json:"command"`
}

func addExamples(registry map[string][]schemeExample, path, description, command string) {
	registry[path] = append(registry[path], schemeExample{Description: description, Command: command})
}

func newSchemeCommand(root *cobra.Command, examples map[string][]schemeExample) *cobra.Command {
	return &cobra.Command{
		Use:     "scheme",
		Short:   "Print the machine-readable command catalog for AI clients.",
		Example: "  crwu scheme",
		Args:    cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			document := struct {
				Version  string          `json:"version"`
				Commands []schemeCommand `json:"commands"`
			}{
				Version:  buildinfo.Version,
				Commands: collectLeaves(root, examples),
			}
			return writeJSON(cmd.OutOrStdout(), document)
		},
	}
}

// collectLeaves walks the cobra tree (excluding the root, help and completion)
// so the catalog always matches help. Leaf names are relative to the root.
func collectLeaves(root *cobra.Command, examples map[string][]schemeExample) []schemeCommand {
	var leaves []schemeCommand
	var walk func(*cobra.Command, []string)
	walk = func(command *cobra.Command, prefix []string) {
		if command.Name() == "help" || command.Name() == "completion" {
			return
		}
		path := append(append([]string{}, prefix...), command.Name())
		if len(command.Commands()) == 0 {
			leaves = append(leaves, schemeCommand{
				Name:        strings.Join(path, " "),
				Description: command.Short,
				Usage:       command.UseLine(),
				Examples:    examples[strings.Join(path, " ")],
			})
			return
		}
		for _, child := range command.Commands() {
			walk(child, path)
		}
	}
	for _, child := range root.Commands() {
		walk(child, nil)
	}
	return leaves
}
