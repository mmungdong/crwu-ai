package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/mmungdong/crwu-ai/internal/app/h3yunops"
	"github.com/mmungdong/crwu-ai/internal/app/h3yunweb"
)

// H3YunOpsService is the agent-gateway (h3pat) capability.
type H3YunOpsService interface {
	Ping(ctx context.Context) (json.RawMessage, error)
	Tools(ctx context.Context) (json.RawMessage, error)
	Call(ctx context.Context, tool string, arguments map[string]any) (json.RawMessage, error)
}

// H3YunWebService is the web-session (employee scope) capability.
type H3YunWebService interface {
	EnsureFresh(ctx context.Context) error
	Login(ctx context.Context, onStatus func(string)) (h3yunweb.Session, error)
	Bind(ctx context.Context, token string) (h3yunweb.Session, error)
	Status(ctx context.Context) (h3yunweb.Session, error)
	Clear(ctx context.Context) error
	Refresh(ctx context.Context) (h3yunweb.Session, error)
	Apps(ctx context.Context, keyword string) (json.RawMessage, error)
	Children(ctx context.Context, appCode string) (json.RawMessage, error)
	SearchForms(ctx context.Context, keyword string) (json.RawMessage, error)
	Records(ctx context.Context, schemaCode string, pageIndex, pageSize int, keyword string) (json.RawMessage, error)
	RecordsGet(ctx context.Context, schemaCode, objectID string) (json.RawMessage, error)
	Files(ctx context.Context, schemaCode, objectID string) ([]h3yunweb.Attachment, error)
	Download(ctx context.Context, schemaCode, objectID, outDir string) ([]string, error)
}

func envH3YunOps(getenv func(string) string) H3YunOpsService {
	if getenv == nil {
		getenv = func(string) string { return "" }
	}
	return h3yunops.EnvService(getenv)
}

func envH3YunWeb(getenv func(string) string) H3YunWebService {
	if getenv == nil {
		getenv = func(string) string { return "" }
	}
	return h3yunweb.EnvService(getenv)
}

type okEnvelope struct {
	OK   bool            `json:"ok"`
	Data json.RawMessage `json:"data,omitempty"`
}

func emitOK(cmd *cobra.Command, data json.RawMessage) error {
	if len(data) == 0 {
		data = json.RawMessage("null")
	}
	return writeJSON(cmd.OutOrStdout(), okEnvelope{OK: true, Data: data})
}

func sessionSummary(session h3yunweb.Session) map[string]any {
	return map[string]any{
		"engineCode": session.EngineCode,
		"userId":     session.UserID,
		"expiresAt":  session.ExpiresAt.UTC().Format(time.RFC3339),
		"expiresIn":  time.Until(session.ExpiresAt).Round(time.Second).String(),
	}
}

func newH3YunCommand(deps Dependencies, examples map[string][]schemeExample) *cobra.Command {
	h3yun := &cobra.Command{
		Use:   "h3yun",
		Short: "H3Yun (氚云) employee-scope data access",
		Long: "H3Yun commands run under the bound employee's permissions.\n" +
			"Start with `crwu h3yun session login`, then browse apps, forms, records and attachments.",
	}
	h3yun.AddCommand(newPingCommand(deps.H3YunOps, examples))
	h3yun.AddCommand(newToolsCommand(deps.H3YunOps, examples))
	h3yun.AddCommand(newSessionCommand(deps.H3YunWeb, examples))
	h3yun.AddCommand(newAppsCommand(deps, examples))
	h3yun.AddCommand(newFormsCommand(deps.H3YunWeb, examples))
	h3yun.AddCommand(newRecordsCommand(deps, examples))
	h3yun.AddCommand(newFilesCommand(deps.H3YunWeb, examples))
	h3yun.AddCommand(newFileCommand(deps.H3YunWeb, examples))
	h3yun.PersistentPreRunE = sessionRenewalMiddleware(deps.H3YunWeb)
	return h3yun
}

// buildLeaf creates a leaf command with an example registered for `scheme`.
func buildLeaf(use, short, long, example string, examples map[string][]schemeExample, path string, flags func(*cobra.Command), run func(*cobra.Command, []string) error) *cobra.Command {
	command := &cobra.Command{
		Use:     use,
		Short:   short,
		Long:    long,
		Example: example,
		Args:    cobra.NoArgs,
		RunE:    run,
	}
	if flags != nil {
		flags(command)
	}
	addExamples(examples, path, short, firstExampleLine(example))
	return command
}

func firstExampleLine(example string) string {
	trimmed := strings.TrimSpace(example)
	for _, line := range strings.Split(trimmed, "\n") {
		candidate := strings.TrimSpace(line)
		if strings.HasPrefix(candidate, "crwu ") {
			return candidate
		}
	}
	return trimmed
}

func noFlags(*cobra.Command) {}

func newPingCommand(ops H3YunOpsService, examples map[string][]schemeExample) *cobra.Command {
	return buildLeaf("ping", "Handshake with the H3Yun agent gateway.", "", "  crwu h3yun ping", examples, "h3yun ping", noFlags,
		func(cmd *cobra.Command, _ []string) error {
			if ops == nil {
				return errors.New("H3Yun agent service is unavailable")
			}
			data, err := ops.Ping(cmd.Context())
			if err != nil {
				return err
			}
			return emitOK(cmd, data)
		})
}

func newToolsCommand(ops H3YunOpsService, examples map[string][]schemeExample) *cobra.Command {
	return buildLeaf("tools", "List the H3Yun agent gateway tools visible to the current token.", "", "  crwu h3yun tools", examples, "h3yun tools", noFlags,
		func(cmd *cobra.Command, _ []string) error {
			if ops == nil {
				return errors.New("H3Yun agent service is unavailable")
			}
			data, err := ops.Tools(cmd.Context())
			if err != nil {
				return err
			}
			return emitOK(cmd, data)
		})
}

func newSessionCommand(web H3YunWebService, examples map[string][]schemeExample) *cobra.Command {
	session := &cobra.Command{
		Use:   "session",
		Short: "Bind and manage the employee's H3Yun web session",
		Long:  "The session token is captured locally and never printed or shared with an AI host.",
	}
	session.AddCommand(buildLeaf("login", "Employee self-service QR login: open a browser, scan with DingTalk, and bind locally.",
		"The session token is read straight from the browser into the local keyring; it never reaches the conversation.",
		"  crwu h3yun session login", examples, "h3yun session login", noFlags,
		func(cmd *cobra.Command, _ []string) error {
			if web == nil {
				return errors.New("H3Yun session service is unavailable")
			}
			ctx, cancel := context.WithTimeout(cmd.Context(), 6*time.Minute)
			defer cancel()
			session, err := web.Login(ctx, func(status string) {
				_, _ = fmt.Fprintln(cmd.OutOrStdout(), status)
			})
			if err != nil {
				return err
			}
			return writeJSON(cmd.OutOrStdout(), map[string]any{"ok": true, "data": sessionSummary(session)})
		}))
	session.AddCommand(buildLeaf("bind", "Bind the employee's H3Yun web session token to this machine.",
		"Fallback / trusted-binder path: pass the session JWT obtained after a QR login.",
		"  crwu h3yun session bind --token <jwt>", examples, "h3yun session bind",
		func(command *cobra.Command) { command.Flags().String("token", "", "H3Yun web session JWT") },
		func(cmd *cobra.Command, _ []string) error {
			if web == nil {
				return errors.New("H3Yun session service is unavailable")
			}
			token, _ := cmd.Flags().GetString("token")
			if strings.TrimSpace(token) == "" {
				return errors.New("required flag --token is missing")
			}
			session, err := web.Bind(cmd.Context(), token)
			if err != nil {
				return err
			}
			return writeJSON(cmd.OutOrStdout(), map[string]any{"ok": true, "data": sessionSummary(session)})
		}))
	session.AddCommand(buildLeaf("status", "Show the bound session identity, engine and expiry.", "", "  crwu h3yun session status", examples, "h3yun session status", noFlags,
		func(cmd *cobra.Command, _ []string) error {
			if web == nil {
				return errors.New("H3Yun session service is unavailable")
			}
			session, err := web.Status(cmd.Context())
			if err != nil {
				return err
			}
			return writeJSON(cmd.OutOrStdout(), map[string]any{"ok": true, "data": sessionSummary(session)})
		}))
	session.AddCommand(buildLeaf("refresh", "Renew the bound H3Yun web session token.", "", "  crwu h3yun session refresh", examples, "h3yun session refresh", noFlags,
		func(cmd *cobra.Command, _ []string) error {
			if web == nil {
				return errors.New("H3Yun session service is unavailable")
			}
			session, err := web.Refresh(cmd.Context())
			if err != nil {
				return err
			}
			return writeJSON(cmd.OutOrStdout(), map[string]any{"ok": true, "data": sessionSummary(session)})
		}))
	session.AddCommand(buildLeaf("clear", "Remove the bound H3Yun web session from this machine.", "", "  crwu h3yun session clear", examples, "h3yun session clear", noFlags,
		func(cmd *cobra.Command, _ []string) error {
			if web == nil {
				return errors.New("H3Yun session service is unavailable")
			}
			if err := web.Clear(cmd.Context()); err != nil {
				return err
			}
			return writeJSON(cmd.OutOrStdout(), map[string]any{"ok": true, "data": map[string]bool{"cleared": true}})
		}))
	return session
}

func newAppsCommand(deps Dependencies, examples map[string][]schemeExample) *cobra.Command {
	apps := &cobra.Command{Use: "apps", Short: "H3Yun applications the employee can access"}
	apps.AddCommand(buildLeaf("list", "List applications the employee can access via the web session.", "", "  crwu h3yun apps list [--keyword <name>]", examples, "h3yun apps list",
		func(command *cobra.Command) { command.Flags().String("keyword", "", "filter by display name or code") },
		func(cmd *cobra.Command, _ []string) error {
			if deps.H3YunWeb == nil {
				return errors.New("H3Yun session service is unavailable")
			}
			keyword, _ := cmd.Flags().GetString("keyword")
			data, err := deps.H3YunWeb.Apps(cmd.Context(), keyword)
			if err != nil {
				return err
			}
			return emitOK(cmd, data)
		}))
	apps.AddCommand(buildLeaf("children", "List the form nodes inside one application.", "", "  crwu h3yun apps children --app <code>", examples, "h3yun apps children",
		func(command *cobra.Command) { command.Flags().String("app", "", "application code (from `apps list`)") },
		func(cmd *cobra.Command, _ []string) error {
			if deps.H3YunWeb == nil {
				return errors.New("H3Yun session service is unavailable")
			}
			appCode, _ := cmd.Flags().GetString("app")
			if strings.TrimSpace(appCode) == "" {
				return errors.New("required flag --app is missing")
			}
			data, err := deps.H3YunWeb.Children(cmd.Context(), appCode)
			if err != nil {
				return err
			}
			return emitOK(cmd, data)
		}))
	apps.AddCommand(buildLeaf("search", "Search applications (agent channel).", "", "  crwu h3yun apps search --keyword <name>", examples, "h3yun apps search",
		func(command *cobra.Command) {
			command.Flags().String("keyword", "", "application name keyword")
			command.Flags().Int("page", 1, "page number, starting at 1")
			command.Flags().Int("size", 20, "page size (1..50)")
		},
		func(cmd *cobra.Command, _ []string) error {
			if deps.H3YunOps == nil {
				return errors.New("H3Yun agent service is unavailable")
			}
			keyword, _ := cmd.Flags().GetString("keyword")
			page, _ := cmd.Flags().GetInt("page")
			size, _ := cmd.Flags().GetInt("size")
			if strings.TrimSpace(keyword) == "" {
				return errors.New("required flag --keyword is missing")
			}
			if page < 1 || size < 1 || size > 50 {
				return errors.New("--page must be positive and --size within 1..50")
			}
			data, err := deps.H3YunOps.Call(cmd.Context(), "h3yun_search_apps", map[string]any{
				"keyword": strings.TrimSpace(keyword), "pageIndex": page - 1, "pageSize": size,
			})
			if err != nil {
				return err
			}
			return emitOK(cmd, data)
		}))
	return apps
}

func newFormsCommand(web H3YunWebService, examples map[string][]schemeExample) *cobra.Command {
	forms := &cobra.Command{Use: "forms", Short: "H3Yun forms"}
	forms.AddCommand(buildLeaf("search", "Search forms by name via the web session.", "", "  crwu h3yun forms search --keyword <name>", examples, "h3yun forms search",
		func(command *cobra.Command) { command.Flags().String("keyword", "", "form name keyword") },
		func(cmd *cobra.Command, _ []string) error {
			if web == nil {
				return errors.New("H3Yun session service is unavailable")
			}
			keyword, _ := cmd.Flags().GetString("keyword")
			if strings.TrimSpace(keyword) == "" {
				return errors.New("required flag --keyword is missing")
			}
			data, err := web.SearchForms(cmd.Context(), keyword)
			if err != nil {
				return err
			}
			return emitOK(cmd, data)
		}))
	return forms
}

func newRecordsCommand(deps Dependencies, examples map[string][]schemeExample) *cobra.Command {
	records := &cobra.Command{Use: "records", Short: "H3Yun business records"}
	records.AddCommand(buildLeaf("list", "Page through a form's records via the web session.", "", "  crwu h3yun records list --schema <code> [--keyword <kw>]", examples, "h3yun records list",
		func(command *cobra.Command) {
			command.Flags().String("schema", "", "form schema code")
			command.Flags().String("keyword", "", "optional record keyword")
			command.Flags().Int("page", 1, "page number, starting at 1")
			command.Flags().Int("size", 20, "page size (1..100)")
		},
		func(cmd *cobra.Command, _ []string) error {
			if deps.H3YunWeb == nil {
				return errors.New("H3Yun session service is unavailable")
			}
			schemaCode, _ := cmd.Flags().GetString("schema")
			keyword, _ := cmd.Flags().GetString("keyword")
			page, _ := cmd.Flags().GetInt("page")
			size, _ := cmd.Flags().GetInt("size")
			if strings.TrimSpace(schemaCode) == "" {
				return errors.New("required flag --schema is missing")
			}
			if page < 1 || size < 1 || size > 100 {
				return errors.New("--page must be positive and --size within 1..100")
			}
			data, err := deps.H3YunWeb.Records(cmd.Context(), strings.TrimSpace(schemaCode), page-1, size, strings.TrimSpace(keyword))
			if err != nil {
				return err
			}
			return emitOK(cmd, data)
		}))
	records.AddCommand(buildLeaf("get", "Load one record with its fields.", "", "  crwu h3yun records get --schema <code> --id <recordId>", examples, "h3yun records get",
		func(command *cobra.Command) {
			command.Flags().String("schema", "", "form schema code")
			command.Flags().String("id", "", "business record object id")
		},
		func(cmd *cobra.Command, _ []string) error {
			if deps.H3YunWeb == nil {
				return errors.New("H3Yun session service is unavailable")
			}
			schemaCode, _ := cmd.Flags().GetString("schema")
			objectID, _ := cmd.Flags().GetString("id")
			if strings.TrimSpace(schemaCode) == "" || strings.TrimSpace(objectID) == "" {
				return errors.New("required flags --schema and --id are missing")
			}
			data, err := deps.H3YunWeb.RecordsGet(cmd.Context(), strings.TrimSpace(schemaCode), strings.TrimSpace(objectID))
			if err != nil {
				return err
			}
			return emitOK(cmd, data)
		}))
	records.AddCommand(buildLeaf("query", "Query records of a form with a read-only SELECT (agent channel).", "", "  crwu h3yun records query --schema <code> --sql <select>", examples, "h3yun records query",
		func(command *cobra.Command) {
			command.Flags().String("schema", "", "form schema code")
			command.Flags().String("sql", "", "read-only SELECT statement (single line)")
		},
		func(cmd *cobra.Command, _ []string) error {
			if deps.H3YunOps == nil {
				return errors.New("H3Yun agent service is unavailable")
			}
			schemaCode, _ := cmd.Flags().GetString("schema")
			sqlText, _ := cmd.Flags().GetString("sql")
			if strings.TrimSpace(schemaCode) == "" || strings.TrimSpace(sqlText) == "" {
				return errors.New("required flags --schema and --sql are missing")
			}
			if strings.Contains(sqlText, "\n") {
				return errors.New("--sql must be a single line")
			}
			data, err := deps.H3YunOps.Call(cmd.Context(), "h3yun_query_bizobject_list", map[string]any{
				"schemaCode": strings.TrimSpace(schemaCode), "sql": strings.TrimSpace(sqlText),
			})
			if err != nil {
				return err
			}
			return emitOK(cmd, data)
		}))
	return records
}

func newFilesCommand(web H3YunWebService, examples map[string][]schemeExample) *cobra.Command {
	files := &cobra.Command{Use: "files", Short: "Record attachments"}
	files.AddCommand(buildLeaf("list", "List the attachment files of one record.", "", "  crwu h3yun files list --schema <code> --id <recordId>", examples, "h3yun files list",
		func(command *cobra.Command) {
			command.Flags().String("schema", "", "form schema code")
			command.Flags().String("id", "", "business record object id")
		},
		func(cmd *cobra.Command, _ []string) error {
			if web == nil {
				return errors.New("H3Yun session service is unavailable")
			}
			schemaCode, _ := cmd.Flags().GetString("schema")
			objectID, _ := cmd.Flags().GetString("id")
			if strings.TrimSpace(schemaCode) == "" || strings.TrimSpace(objectID) == "" {
				return errors.New("required flags --schema and --id are missing")
			}
			files, err := web.Files(cmd.Context(), strings.TrimSpace(schemaCode), strings.TrimSpace(objectID))
			if err != nil {
				return err
			}
			return writeJSON(cmd.OutOrStdout(), map[string]any{"ok": true, "data": files})
		}))
	return files
}

func newFileCommand(web H3YunWebService, examples map[string][]schemeExample) *cobra.Command {
	file := &cobra.Command{Use: "file", Short: "Record attachment download"}
	file.AddCommand(buildLeaf("download", "Download every attachment of one record to a directory.", "", "  crwu h3yun file download --schema <code> --id <recordId> --out <dir>", examples, "h3yun file download",
		func(command *cobra.Command) {
			command.Flags().String("schema", "", "form schema code")
			command.Flags().String("id", "", "business record object id")
			command.Flags().String("out", ".", "output directory")
		},
		func(cmd *cobra.Command, _ []string) error {
			if web == nil {
				return errors.New("H3Yun session service is unavailable")
			}
			schemaCode, _ := cmd.Flags().GetString("schema")
			objectID, _ := cmd.Flags().GetString("id")
			outDir, _ := cmd.Flags().GetString("out")
			if strings.TrimSpace(schemaCode) == "" || strings.TrimSpace(objectID) == "" {
				return errors.New("required flags --schema and --id are missing")
			}
			if strings.TrimSpace(outDir) == "" {
				outDir = "."
			}
			written, err := web.Download(cmd.Context(), strings.TrimSpace(schemaCode), strings.TrimSpace(objectID), outDir)
			if err != nil {
				return err
			}
			return writeJSON(cmd.OutOrStdout(), map[string]any{"ok": true, "data": map[string]any{"files": written}})
		}))
	return file
}
