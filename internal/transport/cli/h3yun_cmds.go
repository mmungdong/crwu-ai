package cli

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/mmungdong/crwu-ai/internal/app/h3yunops"
)

// H3YunOpsService is the read-side H3Yun capability the CLI calls. All results
// are raw JSON so the transport stays decoupled from H3Yun payload shapes until
// live samples are captured (docs/design-h3yun-connector.md, milestone 3).
type H3YunOpsService interface {
	Ping(ctx context.Context) (json.RawMessage, error)
	Tools(ctx context.Context) (json.RawMessage, error)
	Call(ctx context.Context, tool string, arguments map[string]any) (json.RawMessage, error)
}

const h3yunCallTimeout = 60 * time.Second

func envH3YunOps(getenv func(string) string) H3YunOpsService {
	if getenv == nil {
		getenv = func(string) string { return "" }
	}
	return h3yunops.EnvService(getenv)
}

type outputEnvelope struct {
	OK   bool            `json:"ok"`
	Data json.RawMessage `json:"data,omitempty"`
}

func writeH3YunJSON(stdout io.Writer, data json.RawMessage) error {
	if len(data) == 0 {
		data = json.RawMessage("null")
	}
	return json.NewEncoder(stdout).Encode(outputEnvelope{OK: true, Data: data})
}

func runH3YunPing(deps dependencies, args []string, stdout, stderr io.Writer) int {
	if len(args) != 0 {
		fmt.Fprintf(stderr, "command %q does not accept arguments\n", "h3yun ping")
		return 2
	}
	if deps.ops == nil {
		fmt.Fprintln(stderr, "h3yun ping: H3Yun service is unavailable")
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), h3yunCallTimeout)
	defer cancel()
	data, err := deps.ops.Ping(ctx)
	if err != nil {
		fmt.Fprintf(stderr, "h3yun ping: %v\n", err)
		return 1
	}
	if err := writeH3YunJSON(stdout, data); err != nil {
		return reportOutputError("h3yun ping", err, stderr)
	}
	return 0
}

func runH3YunTools(deps dependencies, args []string, stdout, stderr io.Writer) int {
	if len(args) != 0 {
		fmt.Fprintf(stderr, "command %q does not accept arguments\n", "h3yun tools")
		return 2
	}
	if deps.ops == nil {
		fmt.Fprintln(stderr, "h3yun tools: H3Yun service is unavailable")
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), h3yunCallTimeout)
	defer cancel()
	data, err := deps.ops.Tools(ctx)
	if err != nil {
		fmt.Fprintf(stderr, "h3yun tools: %v\n", err)
		return 1
	}
	if err := writeH3YunJSON(stdout, data); err != nil {
		return reportOutputError("h3yun tools", err, stderr)
	}
	return 0
}

func runH3YunAppsSearch(deps dependencies, args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("h3yun apps search", flag.ContinueOnError)
	flags.SetOutput(stderr)
	keyword := flags.String("keyword", "", "application name keyword")
	page := flags.Int("page", 1, "page index, starting at 1")
	size := flags.Int("size", 20, "page size")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintf(stderr, "command %q does not accept positional arguments\n", "h3yun apps search")
		return 2
	}
	if strings.TrimSpace(*keyword) == "" {
		fmt.Fprintln(stderr, "h3yun apps search: --keyword is required")
		return 2
	}
	if *page < 1 || *size < 1 || *size > 50 {
		fmt.Fprintln(stderr, "h3yun apps search: --page must be positive and --size must be within 1..50")
		return 2
	}
	if deps.ops == nil {
		fmt.Fprintln(stderr, "h3yun apps search: H3Yun service is unavailable")
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), h3yunCallTimeout)
	defer cancel()
	// The gateway indexes pages from 0; the CLI exposes 1-based page numbers.
	data, err := deps.ops.Call(ctx, "h3yun_search_apps", map[string]any{
		"keyword":   strings.TrimSpace(*keyword),
		"pageIndex": *page - 1,
		"pageSize":  *size,
	})
	if err != nil {
		fmt.Fprintf(stderr, "h3yun apps search: %v\n", err)
		return 1
	}
	if err := writeH3YunJSON(stdout, data); err != nil {
		return reportOutputError("h3yun apps search", err, stderr)
	}
	return 0
}

func runH3YunRecordsQuery(deps dependencies, args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("h3yun records query", flag.ContinueOnError)
	flags.SetOutput(stderr)
	schemaCode := flags.String("schema", "", "H3Yun form schema code")
	query := flags.String("sql", "", "read-only SELECT statement (single FROM and single LIMIT, no newlines)")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintf(stderr, "command %q does not accept positional arguments\n", "h3yun records query")
		return 2
	}
	if strings.TrimSpace(*schemaCode) == "" {
		fmt.Fprintln(stderr, "h3yun records query: --schema is required")
		return 2
	}
	if strings.TrimSpace(*query) == "" {
		fmt.Fprintln(stderr, "h3yun records query: --sql is required")
		return 2
	}
	if strings.Contains(*query, "\n") {
		fmt.Fprintln(stderr, "h3yun records query: --sql must be a single line")
		return 2
	}
	if deps.ops == nil {
		fmt.Fprintln(stderr, "h3yun records query: H3Yun service is unavailable")
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), h3yunCallTimeout)
	defer cancel()
	data, err := deps.ops.Call(ctx, "h3yun_query_bizobject_list", map[string]any{
		"schemaCode": strings.TrimSpace(*schemaCode),
		"sql":        strings.TrimSpace(*query),
	})
	if err != nil {
		fmt.Fprintf(stderr, "h3yun records query: %v\n", err)
		return 1
	}
	if err := writeH3YunJSON(stdout, data); err != nil {
		return reportOutputError("h3yun records query", err, stderr)
	}
	return 0
}
