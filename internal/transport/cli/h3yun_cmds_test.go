package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

type fakeH3YunOps struct {
	pingData json.RawMessage
	pingErr  error
	tools    json.RawMessage
	toolsErr error
	tool     string
	args     map[string]any
	data     json.RawMessage
	err      error
}

func (f *fakeH3YunOps) Ping(context.Context) (json.RawMessage, error) {
	return f.pingData, f.pingErr
}

func (f *fakeH3YunOps) Tools(context.Context) (json.RawMessage, error) {
	return f.tools, f.toolsErr
}

func (f *fakeH3YunOps) Call(_ context.Context, tool string, arguments map[string]any) (json.RawMessage, error) {
	f.tool = tool
	f.args = arguments
	if f.err != nil {
		return nil, f.err
	}
	return f.data, nil
}

func runH3Yun(deps dependencies, args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := runWithDependencies(args, &stdout, &stderr, deps)
	return code, stdout.String(), stderr.String()
}

func decodeEnvelope(t *testing.T, output string) (bool, json.RawMessage) {
	t.Helper()
	var envelope struct {
		OK   bool            `json:"ok"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal([]byte(output), &envelope); err != nil {
		t.Fatalf("output is not JSON: %v\noutput: %s", err, output)
	}
	return envelope.OK, envelope.Data
}

func TestRunH3YunToolsWritesCatalog(t *testing.T) {
	ops := &fakeH3YunOps{tools: json.RawMessage(`[{"name":"h3yun_search_apps"}]`)}
	code, stdout, stderr := runH3Yun(dependencies{ops: ops}, "h3yun", "tools")
	if code != 0 {
		t.Fatalf("exit code = %d, want 0; stderr = %q", code, stderr)
	}
	if _, data := decodeEnvelope(t, stdout); !strings.Contains(string(data), "h3yun_search_apps") {
		t.Fatalf("stdout = %q", stdout)
	}
}

func TestRunH3YunPingWritesGatewayIdentity(t *testing.T) {
	ops := &fakeH3YunOps{pingData: json.RawMessage(`{"name":"h3yun-agent-platform-tools","version":"1.0.0"}`)}
	code, stdout, stderr := runH3Yun(dependencies{ops: ops}, "h3yun", "ping")
	if code != 0 {
		t.Fatalf("exit code = %d, want 0; stderr = %q", code, stderr)
	}
	ok, data := decodeEnvelope(t, stdout)
	if !ok || !strings.Contains(string(data), "h3yun-agent-platform-tools") {
		t.Fatalf("stdout = %q, want ok with gateway identity", stdout)
	}
}

func TestRunH3YunPingReportsServiceError(t *testing.T) {
	ops := &fakeH3YunOps{pingErr: errors.New("H3YUN_TOKEN is not set")}
	code, _, stderr := runH3Yun(dependencies{ops: ops}, "h3yun", "ping")
	if code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
	if !strings.Contains(stderr, "H3YUN_TOKEN is not set") {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestRunH3YunPingRejectsArguments(t *testing.T) {
	code, _, stderr := runH3Yun(dependencies{}, "h3yun", "ping", "extra")
	if code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(stderr, "does not accept arguments") {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestRunH3YunAppsSearchPassesArguments(t *testing.T) {
	ops := &fakeH3YunOps{data: json.RawMessage(`{"total":1,"data":[{"name":"CRM"}]}`)}
	code, stdout, stderr := runH3Yun(
		dependencies{ops: ops},
		"h3yun", "apps", "search", "--keyword", "CRM", "--page", "2", "--size", "5",
	)
	if code != 0 {
		t.Fatalf("exit code = %d, want 0; stderr = %q", code, stderr)
	}
	if ops.tool != "h3yun_search_apps" {
		t.Fatalf("tool = %q, want h3yun_search_apps", ops.tool)
	}
	// The CLI exposes 1-based pages; the gateway indexes from 0.
	if ops.args["keyword"] != "CRM" || ops.args["pageIndex"] != 1 || ops.args["pageSize"] != 5 {
		t.Fatalf("args = %#v", ops.args)
	}
	ok, data := decodeEnvelope(t, stdout)
	if !ok || !strings.Contains(string(data), `"total":1`) {
		t.Fatalf("stdout = %q", stdout)
	}
}

func TestRunH3YunAppsSearchRequiresKeyword(t *testing.T) {
	code, _, stderr := runH3Yun(dependencies{ops: &fakeH3YunOps{}}, "h3yun", "apps", "search")
	if code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(stderr, "--keyword is required") {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestRunH3YunAppsSearchReportsGatewayError(t *testing.T) {
	ops := &fakeH3YunOps{err: errors.New("H3Yun gateway error 403: no access")}
	code, _, stderr := runH3Yun(dependencies{ops: ops}, "h3yun", "apps", "search", "--keyword", "CRM")
	if code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
	if !strings.Contains(stderr, "no access") {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestRunH3YunRecordsQueryRequiresSchemaAndSQL(t *testing.T) {
	code, _, stderr := runH3Yun(dependencies{ops: &fakeH3YunOps{}}, "h3yun", "records", "query")
	if code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(stderr, "--schema is required") {
		t.Fatalf("stderr = %q", stderr)
	}

	code, _, stderr = runH3Yun(dependencies{ops: &fakeH3YunOps{}}, "h3yun", "records", "query", "--schema", "D0001")
	if code != 2 || !strings.Contains(stderr, "--sql is required") {
		t.Fatalf("exit code = %d, stderr = %q", code, stderr)
	}
}

func TestRunH3YunRecordsQueryCallsGateway(t *testing.T) {
	ops := &fakeH3YunOps{data: json.RawMessage(`{"rows":[]}`)}
	code, stdout, stderr := runH3Yun(
		dependencies{ops: ops},
		"h3yun", "records", "query", "--schema", "D0001", "--sql", "SELECT * FROM BizObject LIMIT 20",
	)
	if code != 0 {
		t.Fatalf("exit code = %d, want 0; stderr = %q", code, stderr)
	}
	if ops.tool != "h3yun_query_bizobject_list" {
		t.Fatalf("tool = %q", ops.tool)
	}
	if len(ops.args) != 2 || ops.args["schemaCode"] != "D0001" || ops.args["sql"] != "SELECT * FROM BizObject LIMIT 20" {
		t.Fatalf("args = %#v, want exactly schemaCode and sql", ops.args)
	}
	if _, data := decodeEnvelope(t, stdout); !strings.Contains(string(data), `"rows":[]`) {
		t.Fatalf("stdout = %q", stdout)
	}
}

func TestRunH3YunRecordsQueryRejectsMultilineSQL(t *testing.T) {
	code, _, stderr := runH3Yun(
		dependencies{ops: &fakeH3YunOps{}},
		"h3yun", "records", "query", "--schema", "D0001", "--sql", "SELECT *\nFROM BizObject",
	)
	if code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(stderr, "single line") {
		t.Fatalf("stderr = %q", stderr)
	}
}
