package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/mmungdong/crwu-ai/internal/app/h3yunlogin"
	"github.com/mmungdong/crwu-ai/internal/auth"
)

func TestRunH3YunLoginUsesDingTalkAndWritesExplicitIdentityJSON(t *testing.T) {
	login := &fakeH3YunLogin{
		result: h3yunlogin.Result{
			Principal: auth.Principal{
				Provider: "dingtalk",
				CorpID:   "ding-corp",
				UserID:   "ding-user-1",
				UnionID:  "union-1",
				OpenID:   "open-1",
				Name:     "Test Employee",
			},
			ExpiresAt: time.Date(2026, 9, 3, 14, 0, 0, 0, time.UTC),
		},
	}
	var stdout, stderr bytes.Buffer
	code := runWithDependencies(
		[]string{"h3yun", "login", "--server", "https://crwu.example.com", "--no-browser", "--json"},
		&stdout,
		&stderr,
		dependencies{login: login, getenv: func(string) string { return "" }},
	)

	if code != 0 {
		t.Fatalf("exit code = %d, want 0; stderr = %q", code, stderr.String())
	}
	if login.request.ServerURL != "https://crwu.example.com" || login.request.OpenBrowser {
		t.Fatalf("login request = %#v", login.request)
	}
	var output struct {
		Authenticated bool   `json:"authenticated"`
		Provider      string `json:"provider"`
		CorpID        string `json:"corpId"`
		UserID        string `json:"userId"`
		UnionID       string `json:"unionId"`
		OpenID        string `json:"openId"`
		Name          string `json:"name"`
		H3YunMapping  string `json:"h3yunIdentity"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		t.Fatalf("stdout is not JSON: %v; output = %q", err, stdout.String())
	}
	if !output.Authenticated || output.Provider != "dingtalk" || output.CorpID != "ding-corp" || output.UserID != "ding-user-1" || output.UnionID != "union-1" || output.OpenID != "open-1" || output.Name != "Test Employee" {
		t.Fatalf("output = %#v", output)
	}
	if output.H3YunMapping != "not_mapped" {
		t.Fatalf("h3yunIdentity = %q, want not_mapped", output.H3YunMapping)
	}
	if strings.Contains(stdout.String(), "token") {
		t.Fatalf("stdout exposes a token: %q", stdout.String())
	}
}

func TestRunH3YunLoginReadsServerFromEnvironmentAndOpensBrowserByDefault(t *testing.T) {
	login := &fakeH3YunLogin{result: h3yunlogin.Result{
		Principal: auth.Principal{Provider: "dingtalk", CorpID: "corp", UserID: "user", UnionID: "union", OpenID: "open"},
		ExpiresAt: time.Now().Add(time.Hour),
	}}
	var stdout, stderr bytes.Buffer
	code := runWithDependencies(
		[]string{"h3yun", "login"},
		&stdout,
		&stderr,
		dependencies{login: login, getenv: func(name string) string {
			if name == "CRWU_SERVER_URL" {
				return "https://crwu.example.com"
			}
			return ""
		}},
	)

	if code != 0 {
		t.Fatalf("exit code = %d, want 0; stderr = %q", code, stderr.String())
	}
	if !login.request.OpenBrowser {
		t.Fatal("OpenBrowser = false, want true")
	}
	if !strings.Contains(stdout.String(), "DingTalk authentication succeeded") || !strings.Contains(stdout.String(), "userId: user") || !strings.Contains(stdout.String(), "H3Yun identity: not mapped") {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestRunH3YunLoginRequiresServerURL(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := runWithDependencies(
		[]string{"h3yun", "login"},
		&stdout,
		&stderr,
		dependencies{login: &fakeH3YunLogin{}, getenv: func(string) string { return "" }},
	)
	if code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(stderr.String(), "CRWU server URL is required") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

type fakeH3YunLogin struct {
	request h3yunlogin.Request
	result  h3yunlogin.Result
	err     error
}

func (f *fakeH3YunLogin) Login(_ context.Context, request h3yunlogin.Request) (h3yunlogin.Result, error) {
	f.request = request
	if request.OnAuthorizationRequired != nil {
		request.OnAuthorizationRequired("https://login.dingtalk.example/oauth2/auth")
	}
	return f.result, f.err
}
