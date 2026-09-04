package scanlogin

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// This file resolves the employee's default browser. Reading the H3Yun session
// cookie requires the Chrome DevTools Protocol, so only Chromium-family
// browsers can be driven; a non-Chromium default (Safari, Firefox) falls back
// to installed Chromium browsers.

// chromiumBundlePaths maps macOS default-handler bundle IDs to executables.
var chromiumBundlePaths = map[string]string{
	"com.google.Chrome":          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"com.google.Chrome.beta":     "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
	"com.microsoft.edgemac":      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"com.brave.Browser":          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
	"com.operasoftware.Opera":    "/Applications/Opera.app/Contents/MacOS/Opera",
	"com.vivaldi.Vivaldi":        "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
	"com.chromium.Chromium":      "/Applications/Chromium.app/Contents/MacOS/Chromium",
	"company.thebrowser.Browser": "/Applications/Arc.app/Contents/MacOS/Arc",
}

// knownBrowserCandidates are well-known Chromium-family install locations.
func knownBrowserCandidates() []string {
	switch runtime.GOOS {
	case "darwin":
		return []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Opera.app/Contents/MacOS/Opera",
			"/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
			"/Applications/Arc.app/Contents/MacOS/Arc",
		}
	case "windows":
		programFiles := os.Getenv("ProgramFiles")
		programFilesX86 := os.Getenv("ProgramFiles(x86)")
		localAppData := os.Getenv("LocalAppData")
		return []string{
			filepath.Join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
			filepath.Join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
		}
	default:
		return []string{
			"google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
			"microsoft-edge", "brave-browser", "vivaldi", "opera",
		}
	}
}

// defaultChromiumBrowser resolves the OS default web browser when it is a
// Chromium-family browser; otherwise it returns "".
func defaultChromiumBrowser() string {
	switch runtime.GOOS {
	case "darwin":
		return defaultBrowserOnDarwin()
	case "windows":
		return defaultBrowserOnWindows()
	default:
		return defaultBrowserOnLinux()
	}
}

// defaultBrowserOnDarwin reads the LaunchServices default handler for https.
func defaultBrowserOnDarwin() string {
	plist := filepath.Join(os.Getenv("HOME"), "Library", "Preferences",
		"com.apple.LaunchServices", "com.apple.launchservices.secure.plist")
	if _, err := os.Stat(plist); err != nil {
		return ""
	}
	output, err := exec.Command("plutil", "-convert", "json", "-o", "-", plist).Output()
	if err != nil {
		return ""
	}
	var payload struct {
		LSHandlers []struct {
			LSHandlerURLScheme string `json:"LSHandlerURLScheme"`
			LSHandlerRoleAll   string `json:"LSHandlerRoleAll"`
		} `json:"LSHandlers"`
	}
	if err := json.Unmarshal(output, &payload); err != nil {
		return ""
	}
	for _, handler := range payload.LSHandlers {
		if handler.LSHandlerURLScheme == "https" {
			// A non-Chromium default cannot be driven via CDP; skip it.
			path, ok := chromiumBundlePaths[handler.LSHandlerRoleAll]
			if !ok {
				return ""
			}
			if _, err := os.Stat(path); err == nil {
				return path
			}
			return ""
		}
	}
	return ""
}

// defaultBrowserOnLinux resolves the xdg default browser when Chromium-family.
func defaultBrowserOnLinux() string {
	output, err := exec.Command("xdg-settings", "get", "default-web-browser").Output()
	if err != nil {
		return ""
	}
	name := strings.ToLower(strings.TrimSpace(string(output)))
	for _, key := range []string{"chrome", "chromium", "microsoft-edge", "brave", "vivaldi", "opera"} {
		if strings.Contains(name, key) {
			base := name
			if idx := strings.Index(base, ".desktop"); idx >= 0 {
				base = base[:idx]
			}
			if path, lookupErr := exec.LookPath(base); lookupErr == nil {
				return path
			}
			return base
		}
	}
	return ""
}

// defaultBrowserOnWindows resolves the https UserChoice ProgId when it maps to
// a Chromium-family browser.
func defaultBrowserOnWindows() string {
	output, err := exec.Command("reg", "query",
		`HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice`,
		"/v", "ProgId").Output()
	if err != nil {
		return ""
	}
	line := strings.ToLower(string(output))
	browser := ""
	switch {
	case strings.Contains(line, "chrome"):
		browser = filepath.Join(os.Getenv("ProgramFiles"), "Google", "Chrome", "Application", "chrome.exe")
	case strings.Contains(line, "edge"):
		browser = filepath.Join(os.Getenv("ProgramFiles"), "Microsoft", "Edge", "Application", "msedge.exe")
	case strings.Contains(line, "brave"):
		browser = filepath.Join(os.Getenv("ProgramFiles"), "BraveSoftware", "Brave-Browser", "Application", "brave.exe")
	}
	if browser != "" {
		if _, err := os.Stat(browser); err == nil {
			return browser
		}
	}
	return ""
}
