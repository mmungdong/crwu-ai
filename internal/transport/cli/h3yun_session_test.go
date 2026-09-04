package cli

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/mmungdong/crwu-ai/internal/app/h3yunweb"
)

type fakeH3YunWeb struct {
	session h3yunweb.Session
	err     error
	cleared bool
	keyword string
	apps    json.RawMessage
	appsErr error
}

func (f *fakeH3YunWeb) Login(_ context.Context, onStatus func(string)) (h3yunweb.Session, error) {
	if onStatus != nil {
		onStatus("status line")
	}
	return f.session, nil
}

func (f *fakeH3YunWeb) Bind(_ context.Context, token string) (h3yunweb.Session, error) {
	if f.err != nil {
		return h3yunweb.Session{}, f.err
	}
	return h3yunweb.Session{EngineCode: "eng-1", UserID: "u1", Token: token, ExpiresAt: time.Now().Add(time.Hour)}, nil
}

func (f *fakeH3YunWeb) Status(context.Context) (h3yunweb.Session, error) {
	if f.err != nil {
		return h3yunweb.Session{}, f.err
	}
	return f.session, nil
}

func (f *fakeH3YunWeb) Clear(context.Context) error {
	f.cleared = true
	return f.err
}

func (f *fakeH3YunWeb) Refresh(context.Context) (h3yunweb.Session, error) {
	if f.err != nil {
		return h3yunweb.Session{}, f.err
	}
	return f.session, nil
}

func (f *fakeH3YunWeb) Apps(_ context.Context, keyword string) (json.RawMessage, error) {
	f.keyword = keyword
	if f.appsErr != nil {
		return nil, f.appsErr
	}
	return f.apps, nil
}

func (f *fakeH3YunWeb) Children(_ context.Context, appCode string) (json.RawMessage, error) {
	if f.appsErr != nil {
		return nil, f.appsErr
	}
	return json.RawMessage(`[{"nodeType":200,"displayName":"Form"}]`), nil
}

func (f *fakeH3YunWeb) SearchForms(context.Context, string) (json.RawMessage, error) {
	if f.appsErr != nil {
		return nil, f.appsErr
	}
	return json.RawMessage(`[{"nodeType":200,"displayName":"Form"}]`), nil
}

func (f *fakeH3YunWeb) Records(context.Context, string, int, int, string) (json.RawMessage, error) {
	if f.appsErr != nil {
		return nil, f.appsErr
	}
	return json.RawMessage(`{"rows":[]}`), nil
}

func (f *fakeH3YunWeb) RecordsGet(context.Context, string, string) (json.RawMessage, error) {
	if f.appsErr != nil {
		return nil, f.appsErr
	}
	return json.RawMessage(`{"record":{}}`), nil
}

func (f *fakeH3YunWeb) Files(_ context.Context, schema, id string) ([]h3yunweb.Attachment, error) {
	if f.appsErr != nil {
		return nil, f.appsErr
	}
	return []h3yunweb.Attachment{{Field: "F0000076", FileID: "file-1", FileName: "faq记录.docx", FileSize: "15843", ContentType: "docx"}}, nil
}

func (f *fakeH3YunWeb) Download(_ context.Context, schema, id, outDir string) ([]string, error) {
	if f.appsErr != nil {
		return nil, f.appsErr
	}
	return []string{outDir + "/faq记录.docx"}, nil
}

func TestRunH3YunSessionBindStoresToken(t *testing.T) {
	web := &fakeH3YunWeb{}
	code, stdout, stderr := runH3Yun(dependencies{web: web}, "h3yun", "session", "bind", "--token", "header.payload.sig")
	if code != 0 {
		t.Fatalf("exit code = %d, want 0; stderr = %q", code, stderr)
	}
	if !strings.Contains(stdout, "eng-1") || !strings.Contains(stdout, "u1") {
		t.Fatalf("stdout = %q", stdout)
	}
}

func TestRunH3YunSessionBindRequiresToken(t *testing.T) {
	code, _, stderr := runH3Yun(dependencies{web: &fakeH3YunWeb{}}, "h3yun", "session", "bind")
	if code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(stderr, "--token is required") {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestRunH3YunSessionStatusReportsErrorWhenUnbound(t *testing.T) {
	web := &fakeH3YunWeb{err: errors.New("no session bound")}
	code, _, stderr := runH3Yun(dependencies{web: web}, "h3yun", "session", "status")
	if code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
	if !strings.Contains(stderr, "no session bound") {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestRunH3YunSessionClear(t *testing.T) {
	web := &fakeH3YunWeb{}
	code, stdout, stderr := runH3Yun(dependencies{web: web}, "h3yun", "session", "clear")
	if code != 0 {
		t.Fatalf("exit code = %d, want 0; stderr = %q", code, stderr)
	}
	if !web.cleared {
		t.Fatal("Clear() was not called")
	}
	if !strings.Contains(stdout, `"cleared":true`) {
		t.Fatalf("stdout = %q", stdout)
	}
}

func TestRunH3YunAppsListPassesKeyword(t *testing.T) {
	web := &fakeH3YunWeb{apps: json.RawMessage(`[{"code":"A1","displayName":"项目"}]`)}
	code, stdout, stderr := runH3Yun(dependencies{web: web}, "h3yun", "apps", "list", "--keyword", "项目")
	if code != 0 {
		t.Fatalf("exit code = %d, want 0; stderr = %q", code, stderr)
	}
	if web.keyword != "项目" {
		t.Fatalf("keyword = %q", web.keyword)
	}
	if _, data := decodeEnvelope(t, stdout); !strings.Contains(string(data), "A1") {
		t.Fatalf("stdout = %q", stdout)
	}
}

func TestRunH3YunAppsChildrenRequiresApp(t *testing.T) {
	code, _, stderr := runH3Yun(dependencies{web: &fakeH3YunWeb{}}, "h3yun", "apps", "children")
	if code != 2 || !strings.Contains(stderr, "--app is required") {
		t.Fatalf("exit code = %d, stderr = %q", code, stderr)
	}
}

func TestRunH3YunAppsChildrenCallsService(t *testing.T) {
	web := &fakeH3YunWeb{}
	code, stdout, stderr := runH3Yun(dependencies{web: web}, "h3yun", "apps", "children", "--app", "Aeed1")
	if code != 0 {
		t.Fatalf("exit code = %d, want 0; stderr = %q", code, stderr)
	}
	if _, data := decodeEnvelope(t, stdout); !strings.Contains(string(data), "Form") {
		t.Fatalf("stdout = %q", stdout)
	}
}

func TestRunH3YunRecordsListRequiresSchema(t *testing.T) {
	code, _, stderr := runH3Yun(dependencies{web: &fakeH3YunWeb{}}, "h3yun", "records", "list")
	if code != 2 || !strings.Contains(stderr, "--schema is required") {
		t.Fatalf("exit code = %d, stderr = %q", code, stderr)
	}
}

func TestRunH3YunFilesListPrintsAttachments(t *testing.T) {
	web := &fakeH3YunWeb{}
	code, stdout, stderr := runH3Yun(dependencies{web: web}, "h3yun", "files", "list", "--schema", "S", "--id", "r1")
	if code != 0 {
		t.Fatalf("exit code = %d; stderr = %q", code, stderr)
	}
	if !strings.Contains(stdout, "faq记录.docx") || !strings.Contains(stdout, "F0000076") {
		t.Fatalf("stdout = %q", stdout)
	}
}

func TestRunH3YunFileDownloadWritesOut(t *testing.T) {
	web := &fakeH3YunWeb{}
	code, stdout, stderr := runH3Yun(dependencies{web: web}, "h3yun", "file", "download", "--schema", "S", "--id", "r1", "--out", "/tmp/x")
	if code != 0 {
		t.Fatalf("exit code = %d; stderr = %q", code, stderr)
	}
	if !strings.Contains(stdout, "/tmp/x/faq记录.docx") {
		t.Fatalf("stdout = %q", stdout)
	}
}

func TestRunH3YunSessionLoginCallsLogin(t *testing.T) {
	web := &fakeH3YunWeb{session: h3yunweb.Session{EngineCode: "eng-1", UserID: "u1", ExpiresAt: time.Now().Add(time.Hour)}}
	code, stdout, stderr := runH3Yun(dependencies{web: web}, "h3yun", "session", "login")
	if code != 0 {
		t.Fatalf("exit code = %d, want 0; stderr = %q", code, stderr)
	}
	if !strings.Contains(stdout, "status line") || !strings.Contains(stdout, "eng-1") {
		t.Fatalf("stdout = %q", stdout)
	}
}
