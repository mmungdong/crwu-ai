package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/mmungdong/crwu-ai/internal/buildinfo"
)

type commandHandler func(dependencies, []string, io.Writer, io.Writer) int

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
			Name:        "h3yun ping",
			Description: "Verify the H3Yun personal access token against the H3Yun agent gateway.",
			Usage:       "crwu h3yun ping",
			Examples: []commandExample{
				{
					Description: "Handshake with the H3Yun gateway and print gateway identity as JSON.",
					Command:     "crwu h3yun ping",
				},
			},
			handler: runH3YunPing,
		},
		{
			Name:        "h3yun tools",
			Description: "List the H3Yun agent gateway tools visible to the current employee.",
			Usage:       "crwu h3yun tools",
			Examples: []commandExample{
				{
					Description: "Dump the live tool catalog including input schemas as JSON.",
					Command:     "crwu h3yun tools",
				},
			},
			handler: runH3YunTools,
		},
		{
			Name:        "h3yun apps search",
			Description: "Search H3Yun applications the current employee can access.",
			Usage:       "crwu h3yun apps search --keyword <name> [--page <n>] [--size <n>]",
			Examples: []commandExample{
				{
					Description: "Search applications whose name contains CRM.",
					Command:     "crwu h3yun apps search --keyword CRM",
				},
				{
					Description: "Search applications on page two with ten results per page.",
					Command:     "crwu h3yun apps search --keyword 采购 --page 2 --size 10",
				},
			},
			handler: runH3YunAppsSearch,
		},
		{
			Name:        "h3yun apps children",
			Description: "List the form function nodes inside one H3Yun application.",
			Usage:       "crwu h3yun apps children --app <code>",
			Examples: []commandExample{
				{
					Description: "List the forms under the project management application.",
					Command:     "crwu h3yun apps children --app Aeed989ff20c34c9aaecc054fb64e51c1",
				},
			},
			handler: runH3YunAppsChildren,
		},
		{
			Name:        "h3yun forms search",
			Description: "Search H3Yun forms by name keyword via the web session.",
			Usage:       "crwu h3yun forms search --keyword <name>",
			Examples: []commandExample{
				{
					Description: "Search forms whose name contains project.",
					Command:     "crwu h3yun forms search --keyword 项目",
				},
			},
			handler: runH3YunFormsSearch,
		},
		{
			Name:        "h3yun records list",
			Description: "List H3Yun business records of a form via the web session.",
			Usage:       "crwu h3yun records list --schema <code> [--page <n>] [--size <n>] [--keyword <kw>]",
			Examples: []commandExample{
				{
					Description: "List the first page of records of a form.",
					Command:     "crwu h3yun records list --schema D0001",
				},
			},
			handler: runH3YunRecordsList,
		},
		{
			Name:        "h3yun records get",
			Description: "Load one H3Yun business record including its attachment fields.",
			Usage:       "crwu h3yun records get --schema <code> --id <objectId>",
			Examples: []commandExample{
				{
					Description: "Load a customer record and its file attachments.",
					Command:     "crwu h3yun records get --schema Syxwvsuwmyagdm66hdtho11ux4 --id cbd35076-1360-4b3f-89df-1821c2780edc",
				},
			},
			handler: runH3YunRecordsGet,
		},
		{
			Name:        "h3yun files list",
			Description: "List the attachment files of one H3Yun business record.",
			Usage:       "crwu h3yun files list --schema <code> --id <objectId>",
			Examples: []commandExample{
				{
					Description: "List the attachments of a report audit record.",
					Command:     "crwu h3yun files list --schema Srabfcm8figc1xuzxawc5u04x5 --id 236d2341-b05a-46fc-8f31-807dcecfc083",
				},
			},
			handler: runH3YunFilesList,
		},
		{
			Name:        "h3yun file download",
			Description: "Download every attachment of one H3Yun business record to a directory.",
			Usage:       "crwu h3yun file download --schema <code> --id <objectId> --out <dir>",
			Examples: []commandExample{
				{
					Description: "Download all attachments of a report audit record into ./files.",
					Command:     "crwu h3yun file download --schema Srabfcm8figc1xuzxawc5u04x5 --id 236d2341-b05a-46fc-8f31-807dcecfc083 --out ./files",
				},
			},
			handler: runH3YunFileDownload,
		},
		{
			Name:        "h3yun records query",
			Description: "Query H3Yun business records of a form with a read-only SELECT statement.",
			Usage:       "crwu h3yun records query --schema <code> --sql <select>",
			Examples: []commandExample{
				{
					Description: "Query active purchase orders of a form using its schema code.",
					Command:     "crwu h3yun records query --schema D0000001 --sql \"SELECT * FROM BizObject WHERE Status = 1 LIMIT 20\"",
				},
			},
			handler: runH3YunRecordsQuery,
		},
		{
			Name:        "h3yun session login",
			Description: "Employee self-service QR login: opens a browser, captures the H3Yun session locally, and binds it.",
			Usage:       "crwu h3yun session login",
			Examples: []commandExample{
				{
					Description: "Let the employee scan the DingTalk QR code to bind their H3Yun session.",
					Command:     "crwu h3yun session login",
				},
			},
			handler: runH3YunSessionLogin,
		},
		{
			Name:        "h3yun session bind",
			Description: "Bind the H3Yun web session token of the current employee to this machine.",
			Usage:       "crwu h3yun session bind --token <jwt>",
			Examples: []commandExample{
				{
					Description: "Store the session JWT copied from the browser after QR login at h3yun.com.",
					Command:     "crwu h3yun session bind --token eyJhbGciOi...",
				},
			},
			handler: runH3YunSessionBind,
		},
		{
			Name:        "h3yun session status",
			Description: "Show the bound H3Yun session identity and its expiry.",
			Usage:       "crwu h3yun session status",
			Examples: []commandExample{
				{
					Description: "Show the stored employee, engine, and remaining session time.",
					Command:     "crwu h3yun session status",
				},
			},
			handler: runH3YunSessionStatus,
		},
		{
			Name:        "h3yun session refresh",
			Description: "Refresh the bound H3Yun web session token.",
			Usage:       "crwu h3yun session refresh",
			Examples: []commandExample{
				{
					Description: "Renew the stored session before its 48 hour expiry.",
					Command:     "crwu h3yun session refresh",
				},
			},
			handler: runH3YunSessionRefresh,
		},
		{
			Name:        "h3yun session clear",
			Description: "Remove the bound H3Yun web session from this machine.",
			Usage:       "crwu h3yun session clear",
			Examples: []commandExample{
				{
					Description: "Forget the stored H3Yun session credential.",
					Command:     "crwu h3yun session clear",
				},
			},
			handler: runH3YunSessionClear,
		},
		{
			Name:        "h3yun apps list",
			Description: "List H3Yun applications the current employee can access via the web session.",
			Usage:       "crwu h3yun apps list [--keyword <name>]",
			Examples: []commandExample{
				{
					Description: "List every accessible application.",
					Command:     "crwu h3yun apps list",
				},
				{
					Description: "List applications whose name or code contains project.",
					Command:     "crwu h3yun apps list --keyword 项目",
				},
			},
			handler: runH3YunAppsList,
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
	return runWithDependencies(args, stdout, stderr, defaultDependencies())
}

// RunWithDependencies executes the CLI using application services assembled by
// the process entry point.
func RunWithDependencies(args []string, stdout, stderr io.Writer, configured Dependencies) int {
	return runWithDependencies(args, stdout, stderr, dependencies{
		ops:    configured.H3YunOps,
		web:    configured.H3YunWeb,
		getenv: configured.Getenv,
	})
}

func runWithDependencies(args []string, stdout, stderr io.Writer, deps dependencies) int {
	if len(args) == 0 {
		_ = writeUsage(stderr)
		return 2
	}

	if args[0] == "-h" || args[0] == "--help" {
		return runHelp(deps, args[1:], stdout, stderr)
	}

	for _, command := range commandDefinitions() {
		nameParts := strings.Fields(command.Name)
		if hasCommandPrefix(args, nameParts) {
			return command.handler(deps, args[len(nameParts):], stdout, stderr)
		}
	}

	fmt.Fprintf(stderr, "unknown command %q\n\n", args[0])
	_ = writeUsage(stderr)
	return 2
}

func hasCommandPrefix(args, nameParts []string) bool {
	if len(args) < len(nameParts) {
		return false
	}
	for index := range nameParts {
		if args[index] != nameParts[index] {
			return false
		}
	}
	return true
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

func runHelp(_ dependencies, args []string, stdout, stderr io.Writer) int {
	if code, rejected := rejectArguments("help", args, stderr); rejected {
		return code
	}
	if err := writeUsage(stdout); err != nil {
		return reportOutputError("help", err, stderr)
	}
	return 0
}

func runScheme(_ dependencies, args []string, stdout, stderr io.Writer) int {
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

func runVersion(_ dependencies, args []string, stdout, stderr io.Writer) int {
	if code, rejected := rejectArguments("version", args, stderr); rejected {
		return code
	}
	if _, err := fmt.Fprintln(stdout, buildinfo.PrettyString()); err != nil {
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
