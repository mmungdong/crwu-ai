// Package browser drives a real (headed) Chromium over the DevTools Protocol so
// that an agent can read rendered pages and capture evidence screenshots.
//
// The package deliberately knows nothing about any business domain: which sites
// exist, how to log into them, and what their pages mean are all supplied by the
// caller. Everything here is "get a browser, check a session, fetch a page, take
// a screenshot".
package browser

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
)

// Site is one site the caller wants to drive.
//
// It is supplied by the caller (a JSON file) rather than hard-coded here: the CLI
// must not carry site semantics, otherwise adding a site would need a CLI release.
type Site struct {
	ID string `json:"id"`
	// Label is for humans in diagnostics; never required.
	Label string `json:"label,omitempty"`
	// LoginURL is the page opened for the employee to sign in on.
	LoginURL string `json:"loginUrl"`
	// ProtectedURL is a page that requires a session. It is what the authority
	// check navigates to: a page that loads without a login redirect proves the
	// session works right now, which a cookie's mere presence does not.
	ProtectedURL string `json:"protectedUrl"`
	// AuthCookie is the cookie name whose presence indicates a session.
	AuthCookie string `json:"authCookie"`
	// AuthDomains restricts which cookie domains count. Empty means "any domain".
	AuthDomains []string `json:"authDomains,omitempty"`
}

// LoadSites reads and validates a site list.
//
// Every missing field is reported by name: a site file is authored by hand, and
// "invalid config" without naming the field costs the author a debugging round.
func LoadSites(path string) ([]Site, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取站点配置失败：%w", err)
	}
	var sites []Site
	if err := json.Unmarshal(raw, &sites); err != nil {
		return nil, fmt.Errorf("解析站点配置失败（%s）：%w", path, err)
	}
	if len(sites) == 0 {
		return nil, fmt.Errorf("站点配置为空（%s）：至少需要一个站点", path)
	}

	seen := make(map[string]bool, len(sites))
	for i, site := range sites {
		where := fmt.Sprintf("第 %d 个站点", i+1)
		for _, field := range []struct {
			name  string
			value string
		}{
			{"id", site.ID},
			{"loginUrl", site.LoginURL},
			{"protectedUrl", site.ProtectedURL},
			{"authCookie", site.AuthCookie},
		} {
			if strings.TrimSpace(field.value) == "" {
				return nil, fmt.Errorf("%s 缺少 %s", where, field.name)
			}
		}
		if seen[site.ID] {
			return nil, fmt.Errorf("站点 id 重复：%s", site.ID)
		}
		seen[site.ID] = true
		if err := requireAbsoluteURL("loginUrl", site.LoginURL); err != nil {
			return nil, fmt.Errorf("站点 %s：%w", site.ID, err)
		}
		if err := requireAbsoluteURL("protectedUrl", site.ProtectedURL); err != nil {
			return nil, fmt.Errorf("站点 %s：%w", site.ID, err)
		}
	}
	return sites, nil
}

// requireAbsoluteURL rejects anything a browser could not navigate to directly.
// A bare host or a relative path fails here instead of much later, inside a
// headless browser that is harder to read.
func requireAbsoluteURL(field, value string) error {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return fmt.Errorf("%s 不是合法的绝对 URL：%s", field, value)
	}
	return nil
}

// FindSite returns the site with the given id, or an error naming the known ids.
func FindSite(sites []Site, id string) (Site, error) {
	for _, site := range sites {
		if site.ID == id {
			return site, nil
		}
	}
	known := make([]string, 0, len(sites))
	for _, site := range sites {
		known = append(known, site.ID)
	}
	return Site{}, fmt.Errorf("未知的站点 id：%q（已配置：%s）", id, strings.Join(known, "、"))
}
