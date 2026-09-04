package cli

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/mmungdong/crwu-ai/internal/app/h3yunweb"
)

// H3YunWebService is the session-channel (web console REST) capability exposed
// to the CLI.
type H3YunWebService interface {
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

func envH3YunWeb(getenv func(string) string) H3YunWebService {
	if getenv == nil {
		getenv = func(string) string { return "" }
	}
	return h3yunweb.EnvService(getenv)
}

func writeH3YunWebJSON(stdout io.Writer, data any) error {
	return json.NewEncoder(stdout).Encode(map[string]any{"ok": true, "data": data})
}

func sessionSummary(session h3yunweb.Session) map[string]any {
	return map[string]any{
		"engineCode": session.EngineCode,
		"userId":     session.UserID,
		"expiresAt":  session.ExpiresAt.UTC().Format(time.RFC3339),
		"expiresIn":  time.Until(session.ExpiresAt).Round(time.Second).String(),
	}
}

func runH3YunSessionBind(deps dependencies, args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("h3yun session bind", flag.ContinueOnError)
	flags.SetOutput(stderr)
	token := flags.String("token", "", "H3Yun web session JWT (from browser DevTools after QR login at h3yun.com)")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintf(stderr, "command %q does not accept positional arguments\n", "h3yun session bind")
		return 2
	}
	if strings.TrimSpace(*token) == "" {
		fmt.Fprintln(stderr, "h3yun session bind: --token is required; copy the Authorization bearer value from the browser")
		return 2
	}
	if deps.web == nil {
		fmt.Fprintln(stderr, "h3yun session bind: H3Yun session service is unavailable")
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), h3yunCallTimeout)
	defer cancel()
	session, err := deps.web.Bind(ctx, *token)
	if err != nil {
		fmt.Fprintf(stderr, "h3yun session bind: %v\n", err)
		return 1
	}
	if err := writeH3YunWebJSON(stdout, sessionSummary(session)); err != nil {
		return reportOutputError("h3yun session bind", err, stderr)
	}
	return 0
}

func runH3YunSessionStatus(deps dependencies, args []string, stdout, stderr io.Writer) int {
	if len(args) != 0 {
		fmt.Fprintf(stderr, "command %q does not accept arguments\n", "h3yun session status")
		return 2
	}
	if deps.web == nil {
		fmt.Fprintln(stderr, "h3yun session status: H3Yun session service is unavailable")
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), h3yunCallTimeout)
	defer cancel()
	session, err := deps.web.Status(ctx)
	if err != nil {
		fmt.Fprintf(stderr, "h3yun session status: %v\n", err)
		return 1
	}
	if err := writeH3YunWebJSON(stdout, sessionSummary(session)); err != nil {
		return reportOutputError("h3yun session status", err, stderr)
	}
	return 0
}

func runH3YunSessionRefresh(deps dependencies, args []string, stdout, stderr io.Writer) int {
	if len(args) != 0 {
		fmt.Fprintf(stderr, "command %q does not accept arguments\n", "h3yun session refresh")
		return 2
	}
	if deps.web == nil {
		fmt.Fprintln(stderr, "h3yun session refresh: H3Yun session service is unavailable")
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), h3yunCallTimeout)
	defer cancel()
	session, err := deps.web.Refresh(ctx)
	if err != nil {
		fmt.Fprintf(stderr, "h3yun session refresh: %v\n", err)
		return 1
	}
	if err := writeH3YunWebJSON(stdout, sessionSummary(session)); err != nil {
		return reportOutputError("h3yun session refresh", err, stderr)
	}
	return 0
}

func runH3YunSessionClear(deps dependencies, args []string, stdout, stderr io.Writer) int {
	if len(args) != 0 {
		fmt.Fprintf(stderr, "command %q does not accept arguments\n", "h3yun session clear")
		return 2
	}
	if deps.web == nil {
		fmt.Fprintln(stderr, "h3yun session clear: H3Yun session service is unavailable")
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), h3yunCallTimeout)
	defer cancel()
	if err := deps.web.Clear(ctx); err != nil {
		fmt.Fprintf(stderr, "h3yun session clear: %v\n", err)
		return 1
	}
	if err := writeH3YunWebJSON(stdout, map[string]any{"cleared": true}); err != nil {
		return reportOutputError("h3yun session clear", err, stderr)
	}
	return 0
}

func runH3YunAppsList(deps dependencies, args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("h3yun apps list", flag.ContinueOnError)
	flags.SetOutput(stderr)
	keyword := flags.String("keyword", "", "filter applications by display name or code")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintf(stderr, "command %q does not accept positional arguments\n", "h3yun apps list")
		return 2
	}
	if deps.web == nil {
		fmt.Fprintln(stderr, "h3yun apps list: H3Yun session service is unavailable")
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), h3yunCallTimeout)
	defer cancel()
	data, err := deps.web.Apps(ctx, *keyword)
	if err != nil {
		fmt.Fprintf(stderr, "h3yun apps list: %v\n", err)
		return 1
	}
	if err := writeH3YunJSON(stdout, data); err != nil {
		return reportOutputError("h3yun apps list", err, stderr)
	}
	return 0
}

func runH3YunAppsChildren(deps dependencies, args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("h3yun apps children", flag.ContinueOnError)
	flags.SetOutput(stderr)
	appCode := flags.String("app", "", "application code (from apps list)")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintf(stderr, "command %q does not accept positional arguments\n", "h3yun apps children")
		return 2
	}
	if strings.TrimSpace(*appCode) == "" {
		fmt.Fprintln(stderr, "h3yun apps children: --app is required (application code from `crwu h3yun apps list`)")
		return 2
	}
	if deps.web == nil {
		fmt.Fprintln(stderr, "h3yun apps children: H3Yun session service is unavailable")
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), h3yunCallTimeout)
	defer cancel()
	data, err := deps.web.Children(ctx, strings.TrimSpace(*appCode))
	if err != nil {
		fmt.Fprintf(stderr, "h3yun apps children: %v\n", err)
		return 1
	}
	if err := writeH3YunJSON(stdout, data); err != nil {
		return reportOutputError("h3yun apps children", err, stderr)
	}
	return 0
}

func runH3YunFormsSearch(deps dependencies, args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("h3yun forms search", flag.ContinueOnError)
	flags.SetOutput(stderr)
	keyword := flags.String("keyword", "", "form name keyword")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintf(stderr, "command %q does not accept positional arguments\n", "h3yun forms search")
		return 2
	}
	if strings.TrimSpace(*keyword) == "" {
		fmt.Fprintln(stderr, "h3yun forms search: --keyword is required")
		return 2
	}
	if deps.web == nil {
		fmt.Fprintln(stderr, "h3yun forms search: H3Yun session service is unavailable")
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), h3yunCallTimeout)
	defer cancel()
	data, err := deps.web.SearchForms(ctx, strings.TrimSpace(*keyword))
	if err != nil {
		fmt.Fprintf(stderr, "h3yun forms search: %v\n", err)
		return 1
	}
	if err := writeH3YunJSON(stdout, data); err != nil {
		return reportOutputError("h3yun forms search", err, stderr)
	}
	return 0
}

func runH3YunRecordsList(deps dependencies, args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("h3yun records list", flag.ContinueOnError)
	flags.SetOutput(stderr)
	schemaCode := flags.String("schema", "", "form schema code")
	page := flags.Int("page", 1, "page number, starting at 1")
	size := flags.Int("size", 20, "page size (1..100)")
	keyword := flags.String("keyword", "", "optional record keyword")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintf(stderr, "command %q does not accept positional arguments\n", "h3yun records list")
		return 2
	}
	if strings.TrimSpace(*schemaCode) == "" {
		fmt.Fprintln(stderr, "h3yun records list: --schema is required (from `crwu h3yun apps children`)")
		return 2
	}
	if *page < 1 || *size < 1 || *size > 100 {
		fmt.Fprintln(stderr, "h3yun records list: --page must be positive and --size within 1..100")
		return 2
	}
	if deps.web == nil {
		fmt.Fprintln(stderr, "h3yun records list: H3Yun session service is unavailable")
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), h3yunCallTimeout)
	defer cancel()
	data, err := deps.web.Records(ctx, strings.TrimSpace(*schemaCode), *page-1, *size, strings.TrimSpace(*keyword))
	if err != nil {
		fmt.Fprintf(stderr, "h3yun records list: %v\n", err)
		return 1
	}
	if err := writeH3YunJSON(stdout, data); err != nil {
		return reportOutputError("h3yun records list", err, stderr)
	}
	return 0
}

func runH3YunRecordsGet(deps dependencies, args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("h3yun records get", flag.ContinueOnError)
	flags.SetOutput(stderr)
	schemaCode := flags.String("schema", "", "form schema code")
	objectID := flags.String("id", "", "business record object id")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintf(stderr, "command %q does not accept positional arguments\n", "h3yun records get")
		return 2
	}
	if strings.TrimSpace(*schemaCode) == "" || strings.TrimSpace(*objectID) == "" {
		fmt.Fprintln(stderr, "h3yun records get: --schema and --id are required")
		return 2
	}
	if deps.web == nil {
		fmt.Fprintln(stderr, "h3yun records get: H3Yun session service is unavailable")
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), h3yunCallTimeout)
	defer cancel()
	data, err := deps.web.RecordsGet(ctx, strings.TrimSpace(*schemaCode), strings.TrimSpace(*objectID))
	if err != nil {
		fmt.Fprintf(stderr, "h3yun records get: %v\n", err)
		return 1
	}
	if err := writeH3YunJSON(stdout, data); err != nil {
		return reportOutputError("h3yun records get", err, stderr)
	}
	return 0
}

func runH3YunFilesList(deps dependencies, args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("h3yun files list", flag.ContinueOnError)
	flags.SetOutput(stderr)
	schemaCode := flags.String("schema", "", "form schema code")
	objectID := flags.String("id", "", "business record object id")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintf(stderr, "command %q does not accept positional arguments\n", "h3yun files list")
		return 2
	}
	if strings.TrimSpace(*schemaCode) == "" || strings.TrimSpace(*objectID) == "" {
		fmt.Fprintln(stderr, "h3yun files list: --schema and --id are required")
		return 2
	}
	if deps.web == nil {
		fmt.Fprintln(stderr, "h3yun files list: H3Yun session service is unavailable")
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), h3yunCallTimeout)
	defer cancel()
	files, err := deps.web.Files(ctx, strings.TrimSpace(*schemaCode), strings.TrimSpace(*objectID))
	if err != nil {
		fmt.Fprintf(stderr, "h3yun files list: %v\n", err)
		return 1
	}
	if err := writeH3YunWebJSON(stdout, files); err != nil {
		return reportOutputError("h3yun files list", err, stderr)
	}
	return 0
}

func runH3YunFileDownload(deps dependencies, args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("h3yun file download", flag.ContinueOnError)
	flags.SetOutput(stderr)
	schemaCode := flags.String("schema", "", "form schema code")
	objectID := flags.String("id", "", "business record object id")
	outDir := flags.String("out", ".", "output directory")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintf(stderr, "command %q does not accept positional arguments\n", "h3yun file download")
		return 2
	}
	if strings.TrimSpace(*schemaCode) == "" || strings.TrimSpace(*objectID) == "" {
		fmt.Fprintln(stderr, "h3yun file download: --schema and --id are required")
		return 2
	}
	if deps.web == nil {
		fmt.Fprintln(stderr, "h3yun file download: H3Yun session service is unavailable")
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	written, err := deps.web.Download(ctx, strings.TrimSpace(*schemaCode), strings.TrimSpace(*objectID), *outDir)
	if err != nil {
		fmt.Fprintf(stderr, "h3yun file download: %v\n", err)
		return 1
	}
	if err := writeH3YunWebJSON(stdout, map[string]any{"files": written}); err != nil {
		return reportOutputError("h3yun file download", err, stderr)
	}
	return 0
}

func runH3YunSessionLogin(deps dependencies, args []string, stdout, stderr io.Writer) int {
	if len(args) != 0 {
		fmt.Fprintf(stderr, "command %q does not accept arguments\n", "h3yun session login")
		return 2
	}
	if deps.web == nil {
		fmt.Fprintln(stderr, "h3yun session login: H3Yun session service is unavailable")
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	defer cancel()
	var session h3yunweb.Session
	var err error
	session, err = deps.web.Login(ctx, func(status string) {
		if _, writeErr := fmt.Fprintln(stdout, status); writeErr != nil {
			_ = writeErr
		}
	})
	if err != nil {
		fmt.Fprintf(stderr, "h3yun session login: %v\n", err)
		return 1
	}
	if err := writeH3YunWebJSON(stdout, sessionSummary(session)); err != nil {
		return reportOutputError("h3yun session login", err, stderr)
	}
	return 0
}
