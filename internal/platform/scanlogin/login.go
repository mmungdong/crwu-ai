// Package scanlogin lets an employee log into H3Yun by scanning a QR code
// with DingTalk in a browser window that crwu opens itself. The resulting web
// session cookie is read directly from the browser via the Chrome DevTools
// Protocol and returned in-process — it is never printed, logged, or sent to
// any AI host.
package scanlogin

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// H3YunLoginURL is the page crwu opens for the DingTalk QR login. Landing
// directly on the DingTalk login entry avoids the homepage for employees.
const H3YunLoginURL = "https://www.h3yun.com/entry/login/dingtalk"

const (
	sessionCookieName = "h3_token"
	debuggerReadyWait = 10 * time.Second
	cookiePollEvery   = time.Second
	defaultTimeout    = 5 * time.Minute
)

// Config controls the browser session capture.
type Config struct {
	// BrowserPath overrides automatic browser discovery (env CRWU_BROWSER).
	BrowserPath string
	// LoginURL defaults to H3YunLoginURL.
	LoginURL string
	// Timeout bounds the whole capture; defaults to 5 minutes.
	Timeout time.Duration
}

// DiscoverBrowser returns the configured or detected browser executable.
func DiscoverBrowser() string {
	if custom := strings.TrimSpace(os.Getenv("CRWU_BROWSER")); custom != "" {
		return custom
	}
	if path := defaultChromiumBrowser(); path != "" {
		return path
	}
	for _, candidate := range knownBrowserCandidates() {
		if candidate != "" {
			if path, err := exec.LookPath(candidate); err == nil {
				return path
			}
			if _, err := os.Stat(candidate); err == nil {
				return candidate
			}
		}
	}
	return ""
}

type cdpClient struct {
	conn *websocket.Conn
	mu   sync.Mutex
	next int
}

type cdpResponse struct {
	ID     int64           `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (c *cdpClient) call(method string, params map[string]any) (json.RawMessage, error) {
	c.mu.Lock()
	c.next++
	id := int64(c.next)
	c.mu.Unlock()
	payload, err := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	err = c.conn.WriteMessage(websocket.TextMessage, payload)
	c.mu.Unlock()
	if err != nil {
		return nil, err
	}
	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			return nil, err
		}
		var message cdpResponse
		if err := json.Unmarshal(raw, &message); err != nil {
			continue
		}
		if message.ID != id {
			continue // event or another response; ignore
		}
		if message.Error != nil {
			return nil, fmt.Errorf("CDP %s error %d: %s", method, message.Error.Code, message.Error.Message)
		}
		return message.Result, nil
	}
}

// freePort returns a TCP port that was free at reservation time.
func freePort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port, nil
}

func httpGet(url string, timeout time.Duration) ([]byte, error) {
	client := &http.Client{Timeout: timeout}
	response, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d from %s", response.StatusCode, url)
	}
	return io.ReadAll(io.LimitReader(response.Body, 1<<20))
}

// Capture opens a browser window, waits for the employee to finish the DingTalk
// QR scan, and returns the H3Yun session cookie value. The token is only ever
// held in process memory and returned to the caller.
func Capture(ctx context.Context, config Config) (string, error) {
	if config.Timeout <= 0 {
		config.Timeout = defaultTimeout
	}
	browser := strings.TrimSpace(config.BrowserPath)
	if browser == "" {
		browser = DiscoverBrowser()
	}
	if browser == "" {
		return "", errors.New("no supported browser found; install Chrome/Edge or set CRWU_BROWSER")
	}
	loginURL := strings.TrimSpace(config.LoginURL)
	if loginURL == "" {
		loginURL = H3YunLoginURL
	}

	ctx, cancel := context.WithTimeout(ctx, config.Timeout)
	defer cancel()

	port, err := freePort()
	if err != nil {
		return "", err
	}
	profile, err := os.MkdirTemp("", "crwu-scan-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(profile)

	args := []string{
		"--remote-debugging-port=" + strconv.Itoa(port),
		"--user-data-dir=" + profile,
		"--no-first-run",
		"--no-default-browser-check",
		"--remote-allow-origins=*",
		loginURL,
	}
	process := exec.CommandContext(ctx, browser, args...)
	process.Stdout = io.Discard
	process.Stderr = io.Discard
	if err := process.Start(); err != nil {
		return "", fmt.Errorf("start browser: %w", err)
	}
	defer func() {
		if process.Process != nil {
			_ = process.Process.Kill()
		}
		_ = process.Wait()
	}()

	wsURL, err := waitForDebugger(ctx, port)
	if err != nil {
		return "", err
	}
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, wsURL, nil)
	if err != nil {
		return "", fmt.Errorf("connect to browser debugger: %w", err)
	}
	defer conn.Close()
	client := &cdpClient{conn: conn}

	if _, err := client.call("Network.enable", map[string]any{}); err != nil {
		return "", fmt.Errorf("enable network inspection: %w", err)
	}

	ticker := time.NewTicker(cookiePollEvery)
	defer ticker.Stop()
	for {
		if token, ok := cookiesToken(client, loginURL); ok {
			return token, nil
		}
		if token, ok := pageToken(client); ok {
			return token, nil
		}
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("timed out waiting for the DingTalk scan; please retry: %w", ctx.Err())
		case <-ticker.C:
		}
	}
}

// cookiesToken reads the session cookie for the login origin and its bare
// domain, and accepts the value only when it is a valid, unexpired session.
func cookiesToken(client *cdpClient, loginURL string) (string, bool) {
	origins := []string{loginURL}
	if parsed, err := url.Parse(loginURL); err == nil {
		host := strings.TrimPrefix(parsed.Hostname(), "www.")
		origins = append(origins, parsed.Scheme+"://"+host)
	}
	result, err := client.call("Network.getCookies", map[string]any{"urls": origins})
	if err != nil {
		return "", false
	}
	var payload struct {
		Cookies []struct {
			Name   string `json:"name"`
			Domain string `json:"domain"`
			Value  string `json:"value"`
		} `json:"cookies"`
	}
	if err := json.Unmarshal(result, &payload); err != nil {
		return "", false
	}
	for _, cookie := range payload.Cookies {
		if cookie.Name == sessionCookieName && strings.Contains(cookie.Domain, "h3yun.com") && validSessionToken(cookie.Value) {
			return cookie.Value, true
		}
	}
	return "", false
}

// pageToken falls back to reading the token from page state (cookie jar and
// localStorage) in case the app keeps the session outside the cookie domain.
func pageToken(client *cdpClient) (string, bool) {
	expression := `JSON.stringify((function(){var c="",l="";try{c=document.cookie||""}catch(e){}` +
		`try{if(window.localStorage){l=window.localStorage.getItem("h3_token")||""}}catch(e){}` +
		`return {c:c,l:l}})())`
	result, err := client.call("Runtime.evaluate", map[string]any{
		"expression":    expression,
		"returnByValue": true,
	})
	if err != nil {
		return "", false
	}
	var payload struct {
		Result struct {
			Value json.RawMessage `json:"value"`
		} `json:"result"`
	}
	if err := json.Unmarshal(result, &payload); err != nil {
		return "", false
	}
	var state struct {
		Cookie string `json:"c"`
		Local  string `json:"l"`
	}
	if err := json.Unmarshal(payload.Result.Value, &state); err != nil {
		return "", false
	}
	candidates := []string{state.Local}
	if match := cookieValueRegex.FindStringSubmatch(state.Cookie); match != nil {
		candidates = append(candidates, match[1])
	}
	for _, candidate := range candidates {
		if validSessionToken(candidate) {
			return candidate, true
		}
	}
	return "", false
}

var cookieValueRegex = regexp.MustCompile(`(?:^|;\s*)h3_token=([^;]+)`)

// validSessionToken reports whether the captured value looks like an
// unexpired H3Yun session JWT (three segments, engine/user claims, future exp).
func validSessionToken(token string) bool {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 3 {
		return false
	}
	payload := parts[1]
	if rest := len(payload) % 4; rest != 0 {
		payload += strings.Repeat("=", 4-rest)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(payload, "="))
	if err != nil {
		if decoded, err = base64.URLEncoding.DecodeString(payload); err != nil {
			return false
		}
	}
	var claims struct {
		EngineCode string `json:"enginecode"`
		UserID     string `json:"userid"`
		ExpiresAt  int64  `json:"exp"`
	}
	if err := json.Unmarshal(decoded, &claims); err != nil {
		return false
	}
	return claims.EngineCode != "" && claims.UserID != "" && claims.ExpiresAt > time.Now().Unix()
}

func waitForDebugger(ctx context.Context, port int) (string, error) {
	deadline := time.NewTimer(debuggerReadyWait)
	defer deadline.Stop()
	for {
		body, err := httpGet("http://127.0.0.1:"+strconv.Itoa(port)+"/json/list", time.Second)
		if err == nil {
			var targets []struct {
				Type              string `json:"type"`
				WebSocketDebugger string `json:"webSocketDebuggerUrl"`
			}
			if err := json.Unmarshal(body, &targets); err == nil {
				for _, target := range targets {
					if target.Type == "page" && target.WebSocketDebugger != "" {
						return target.WebSocketDebugger, nil
					}
				}
			}
		}
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("browser debugger did not start: %w", ctx.Err())
		case <-deadline.C:
			return "", errors.New("browser debugger did not start in time")
		case <-time.After(200 * time.Millisecond):
		}
	}
}

// ValidateToken ensures a captured value looks like a JWT before it is stored.
func ValidateToken(token string) error {
	if strings.Count(strings.TrimSpace(token), ".") != 2 {
		return errors.New("captured session is not a JWT")
	}
	return nil
}

// RenderURL returns the text shown to the employee (never includes the token).
func RenderURL() string { return H3YunLoginURL }
