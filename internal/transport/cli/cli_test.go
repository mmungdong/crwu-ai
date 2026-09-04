package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/mmungdong/crwu-ai/internal/app/h3yunweb"
	"github.com/mmungdong/crwu-ai/internal/buildinfo"
)

func runCLI(deps Dependencies, args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := RunWithDependencies(args, &stdout, &stderr, deps)
	return code, stdout.String(), stderr.String()
}

func TestHelpIsHierarchical(t *testing.T) {
	code, stdout, stderr := runCLI(envDependencies(func(string) string { return "" }), "help")
	if code != 0 {
		t.Fatalf("help exit = %d, stderr=%q", code, stderr)
	}
	if !strings.Contains(stdout, "crwu") || !strings.Contains(stdout, "h3yun") {
		t.Fatalf("top help = %q", stdout)
	}
	if strings.Contains(stdout, "session bind") {
		t.Fatalf("top help leaked a nested command: %q", stdout)
	}

	code, stdout, stderr = runCLI(envDependencies(func(string) string { return "" }), "help", "h3yun")
	if code != 0 {
		t.Fatalf("h3yun help exit = %d, stderr=%q", code, stderr)
	}
	if !strings.Contains(stdout, "session") || !strings.Contains(stdout, "apps") {
		t.Fatalf("h3yun help = %q", stdout)
	}
	if strings.Contains(stdout, "session bind") || strings.Contains(stdout, "records list") {
		t.Fatalf("h3yun help leaked deeper commands: %q", stdout)
	}

	code, stdout, _ = runCLI(envDependencies(func(string) string { return "" }), "help", "h3yun", "session")
	if code != 0 {
		t.Fatalf("session help exit = %d", code)
	}
	for _, want := range []string{"login", "bind", "status", "refresh", "clear"} {
		if !strings.Contains(stdout, want) {
			t.Fatalf("session help misses %q: %q", want, stdout)
		}
	}
}

func TestUnknownCommandFails(t *testing.T) {
	code, _, stderr := runCLI(envDependencies(func(string) string { return "" }), "nope")
	if code == 0 || !strings.Contains(stderr, "unknown command") {
		t.Fatalf("exit=%d stderr=%q", code, stderr)
	}
}

func TestVersionPrintsBuildInfo(t *testing.T) {
	oldVersion, oldCommit, oldDate := buildinfo.Version, buildinfo.Commit, buildinfo.BuildDate
	t.Cleanup(func() { buildinfo.Version, buildinfo.Commit, buildinfo.BuildDate = oldVersion, oldCommit, oldDate })
	buildinfo.Version, buildinfo.Commit, buildinfo.BuildDate = "1.2.3", "abc123", "2026-09-04T02:00:00Z"

	code, stdout, stderr := runCLI(envDependencies(func(string) string { return "" }), "version")
	if code != 0 {
		t.Fatalf("exit=%d stderr=%q", code, stderr)
	}
	for _, want := range []string{"crwu 1.2.3", "commit    abc123", "2026-09-04 02:00:00 UTC"} {
		if !strings.Contains(stdout, want) {
			t.Fatalf("stdout=%q want %q", stdout, want)
		}
	}
}

func TestSchemeCatalog(t *testing.T) {
	code, stdout, stderr := runCLI(envDependencies(func(string) string { return "" }), "scheme")
	if code != 0 {
		t.Fatalf("exit=%d stderr=%q", code, stderr)
	}
	var doc struct {
		Version  string `json:"version"`
		Commands []struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			Usage       string `json:"usage"`
			Examples    []any  `json:"examples"`
		} `json:"commands"`
	}
	if err := json.Unmarshal([]byte(stdout), &doc); err != nil {
		t.Fatalf("scheme is not valid JSON: %v\n%s", err, stdout)
	}
	found := map[string]bool{}
	names := []string{}
	for _, command := range doc.Commands {
		if command.Description == "" || command.Usage == "" {
			t.Fatalf("command %q is missing description/usage", command.Name)
		}
		found[command.Name] = true
		names = append(names, command.Name)
	}
	for _, want := range []string{"version", "scheme", "h3yun session login", "h3yun apps search", "h3yun file download"} {
		if !found[want] {
			t.Fatalf("catalog missing %q in [%s]", want, names)
		}
	}
}

type fakeOps struct {
	name string
	args map[string]any
	data json.RawMessage
	err  error
}

func (f *fakeOps) Ping(context.Context) (json.RawMessage, error) { return f.data, f.err }
func (f *fakeOps) Tools(context.Context) (json.RawMessage, error) {
	return json.RawMessage(`[]`), f.err
}
func (f *fakeOps) Call(_ context.Context, tool string, arguments map[string]any) (json.RawMessage, error) {
	f.name, f.args = tool, arguments
	if f.err != nil {
		return nil, f.err
	}
	return f.data, nil
}

type fakeWeb struct {
	session h3yunweb.Session
	err     error
	apps    json.RawMessage
	lastKw  string
}

func (f *fakeWeb) Login(_ context.Context, onStatus func(string)) (h3yunweb.Session, error) {
	return f.session, f.err
}
func (f *fakeWeb) Bind(context.Context, string) (h3yunweb.Session, error) { return f.session, f.err }
func (f *fakeWeb) Status(context.Context) (h3yunweb.Session, error)       { return f.session, f.err }
func (f *fakeWeb) Clear(context.Context) error                            { return f.err }
func (f *fakeWeb) Refresh(context.Context) (h3yunweb.Session, error)      { return f.session, f.err }
func (f *fakeWeb) Apps(_ context.Context, keyword string) (json.RawMessage, error) {
	f.lastKw = keyword
	if f.err != nil {
		return nil, f.err
	}
	return f.apps, nil
}
func (f *fakeWeb) Children(context.Context, string) (json.RawMessage, error) {
	return json.RawMessage(`[]`), f.err
}
func (f *fakeWeb) SearchForms(context.Context, string) (json.RawMessage, error) {
	return json.RawMessage(`[]`), f.err
}
func (f *fakeWeb) Records(context.Context, string, int, int, string) (json.RawMessage, error) {
	return json.RawMessage(`{"rows":[]}`), f.err
}
func (f *fakeWeb) RecordsGet(context.Context, string, string) (json.RawMessage, error) {
	return json.RawMessage(`{"ok":1}`), f.err
}
func (f *fakeWeb) Files(context.Context, string, string) ([]h3yunweb.Attachment, error) {
	if f.err != nil {
		return nil, f.err
	}
	return []h3yunweb.Attachment{{Field: "F1", FileID: "id1", FileName: "a.docx"}}, nil
}
func (f *fakeWeb) Download(context.Context, string, string, string) ([]string, error) {
	if f.err != nil {
		return nil, f.err
	}
	return []string{"/tmp/a.docx"}, nil
}

func depsWith(ops H3YunOpsService, web H3YunWebService) Dependencies {
	return Dependencies{H3YunOps: ops, H3YunWeb: web, Getenv: func(string) string { return "" }}
}

func TestAppsListViaSession(t *testing.T) {
	web := &fakeWeb{apps: json.RawMessage(`[{"displayName":"CRM"}]`)}
	code, stdout, stderr := runCLI(depsWith(nil, web), "h3yun", "apps", "list", "--keyword", "C")
	if code != 0 {
		t.Fatalf("exit=%d stderr=%q", code, stderr)
	}
	if web.lastKw != "C" || !strings.Contains(stdout, "CRM") {
		t.Fatalf("stdout=%q lastKw=%q", stdout, web.lastKw)
	}
}

func TestAppsSearchUsesZeroBasedGatewayPage(t *testing.T) {
	ops := &fakeOps{data: json.RawMessage(`{"total":1}`)}
	code, stdout, stderr := runCLI(depsWith(ops, nil), "h3yun", "apps", "search", "--keyword", "CRM", "--page", "3")
	if code != 0 {
		t.Fatalf("exit=%d stderr=%q", code, stderr)
	}
	if ops.name != "h3yun_search_apps" || ops.args["pageIndex"] != 2 || ops.args["keyword"] != "CRM" {
		t.Fatalf("call = %s %#v", ops.name, ops.args)
	}
	if !strings.Contains(stdout, `"total":1`) {
		t.Fatalf("stdout=%q", stdout)
	}
}

func TestSessionStatusUnboundFails(t *testing.T) {
	web := &fakeWeb{err: errors.New("no session bound")}
	code, _, stderr := runCLI(depsWith(nil, web), "h3yun", "session", "status")
	if code == 0 || !strings.Contains(stderr, "no session bound") {
		t.Fatalf("exit=%d stderr=%q", code, stderr)
	}
}

func TestRequiredFlagReportsError(t *testing.T) {
	web := &fakeWeb{}
	code, _, stderr := runCLI(depsWith(nil, web), "h3yun", "session", "bind")
	if code == 0 || !strings.Contains(stderr, "--token") {
		t.Fatalf("exit=%d stderr=%q", code, stderr)
	}
}

func TestSessionLoginStatusLinesAndSummary(t *testing.T) {
	web := &fakeWeb{session: h3yunweb.Session{EngineCode: "eng-1", UserID: "u1", ExpiresAt: time.Now().Add(time.Hour)}}
	code, stdout, stderr := runCLI(depsWith(nil, web), "h3yun", "session", "login")
	if code != 0 {
		t.Fatalf("exit=%d stderr=%q", code, stderr)
	}
	if !strings.Contains(stdout, "eng-1") || !strings.Contains(stdout, `"ok":true`) {
		t.Fatalf("stdout=%q", stdout)
	}
}
