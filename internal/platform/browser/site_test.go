package browser

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeSites 把一段 JSON 写成临时文件，返回路径。
func writeSites(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "sites.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write sites: %v", err)
	}
	return path
}

func TestLoadSitesRejectsMissingRequiredField(t *testing.T) {
	cases := []struct {
		name        string
		body        string
		wantMention string
	}{
		{"no id", `[{"loginUrl":"https://a/","protectedUrl":"https://b/","authCookie":"c"}]`, "id"},
		{"no loginUrl", `[{"id":"ke","protectedUrl":"https://b/","authCookie":"c"}]`, "loginUrl"},
		{"no protectedUrl", `[{"id":"ke","loginUrl":"https://a/","authCookie":"c"}]`, "protectedUrl"},
		{"no authCookie", `[{"id":"ke","loginUrl":"https://a/","protectedUrl":"https://b/"}]`, "authCookie"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := LoadSites(writeSites(t, tc.body))
			if err == nil {
				t.Fatalf("LoadSites() = nil error, want error mentioning %q", tc.wantMention)
			}
			if !strings.Contains(err.Error(), tc.wantMention) {
				t.Fatalf("LoadSites() error = %q, want it to mention %q", err.Error(), tc.wantMention)
			}
		})
	}
}

func TestLoadSitesRejectsDuplicateID(t *testing.T) {
	body := `[
		{"id":"ke","loginUrl":"https://a/","protectedUrl":"https://b/","authCookie":"c"},
		{"id":"ke","loginUrl":"https://d/","protectedUrl":"https://e/","authCookie":"f"}
	]`
	_, err := LoadSites(writeSites(t, body))
	if err == nil {
		t.Fatal("LoadSites() = nil error, want duplicate-id error")
	}
	if !strings.Contains(err.Error(), "ke") {
		t.Fatalf("LoadSites() error = %q, want it to mention the duplicate id %q", err.Error(), "ke")
	}
}

func TestLoadSitesRejectsMissingFile(t *testing.T) {
	_, err := LoadSites(filepath.Join(t.TempDir(), "absent.json"))
	if err == nil {
		t.Fatal("LoadSites() = nil error for a missing file")
	}
}

func TestLoadSitesAcceptsWellFormedEntry(t *testing.T) {
	body := `[{"id":"ke","label":"贝壳","loginUrl":"https://clogin.ke.com/login","protectedUrl":"https://bj.ke.com/ershoufang/chaoyang/","authCookie":"lianjia_token","authDomains":[".ke.com"]}]`
	sites, err := LoadSites(writeSites(t, body))
	if err != nil {
		t.Fatalf("LoadSites() error = %v, want nil", err)
	}
	if len(sites) != 1 {
		t.Fatalf("LoadSites() returned %d sites, want 1", len(sites))
	}
	got := sites[0]
	if got.ID != "ke" || got.Label != "贝壳" || got.AuthCookie != "lianjia_token" {
		t.Fatalf("LoadSites() = %+v, want the fields read verbatim", got)
	}
	if len(got.AuthDomains) != 1 || got.AuthDomains[0] != ".ke.com" {
		t.Fatalf("LoadSites() AuthDomains = %v, want [.ke.com]", got.AuthDomains)
	}
}

func TestFindSiteUnknownIDListsKnownIDs(t *testing.T) {
	sites := []Site{{ID: "ke"}, {ID: "lianjia"}}
	_, err := FindSite(sites, "anjuke")
	if err == nil {
		t.Fatal("FindSite() = nil error for an unknown id")
	}
	msg := err.Error()
	for _, want := range []string{"anjuke", "ke", "lianjia"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("FindSite() error = %q, want it to mention %q", msg, want)
		}
	}
}

func TestFindSiteReturnsMatch(t *testing.T) {
	sites := []Site{{ID: "ke", Label: "贝壳"}, {ID: "lianjia"}}
	got, err := FindSite(sites, "lianjia")
	if err != nil {
		t.Fatalf("FindSite() error = %v, want nil", err)
	}
	if got.ID != "lianjia" {
		t.Fatalf("FindSite() = %+v, want id lianjia", got)
	}
}
