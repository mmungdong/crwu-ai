package cli

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/mmungdong/crwu-ai/internal/app/h3yunlogin"
)

type H3YunLoginService interface {
	Login(ctx context.Context, request h3yunlogin.Request) (h3yunlogin.Result, error)
}

type Dependencies struct {
	H3YunLogin H3YunLoginService
	H3YunOps   H3YunOpsService
	H3YunWeb   H3YunWebService
	Getenv     func(string) string
}

type dependencies struct {
	login  H3YunLoginService
	ops    H3YunOpsService
	web    H3YunWebService
	getenv func(string) string
}

func defaultDependencies() dependencies {
	getenv := os.Getenv
	return dependencies{
		getenv: getenv,
		ops:    envH3YunOps(getenv),
		web:    envH3YunWeb(getenv),
	}
}

func runH3YunLogin(deps dependencies, args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("h3yun login", flag.ContinueOnError)
	flags.SetOutput(stderr)
	serverURL := flags.String("server", "", "CRWU server URL")
	noBrowser := flags.Bool("no-browser", false, "do not open the authorization URL")
	jsonOutput := flags.Bool("json", false, "write the authenticated identity as JSON")
	timeout := flags.Duration("timeout", 5*time.Minute, "maximum time to wait for DingTalk authorization")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintf(stderr, "command %q does not accept positional arguments\n", "h3yun login")
		return 2
	}
	if *timeout <= 0 {
		fmt.Fprintln(stderr, "h3yun login: timeout must be greater than zero")
		return 2
	}
	if strings.TrimSpace(*serverURL) == "" && deps.getenv != nil {
		*serverURL = deps.getenv("CRWU_SERVER_URL")
	}
	if strings.TrimSpace(*serverURL) == "" {
		fmt.Fprintln(stderr, "h3yun login: CRWU server URL is required; pass --server or set CRWU_SERVER_URL")
		return 2
	}
	if deps.login == nil {
		fmt.Fprintln(stderr, "h3yun login: login service is unavailable")
		return 1
	}

	progress := stdout
	if *jsonOutput {
		progress = stderr
	}
	var progressErr error
	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	result, err := deps.login.Login(ctx, h3yunlogin.Request{
		ServerURL:   strings.TrimSpace(*serverURL),
		OpenBrowser: !*noBrowser,
		OnAuthorizationRequired: func(authorizationURL string) {
			_, progressErr = fmt.Fprintf(progress, "Complete DingTalk authorization at:\n%s\nWaiting for DingTalk...\n", authorizationURL)
		},
	})
	if progressErr != nil {
		return reportOutputError("h3yun login", progressErr, stderr)
	}
	if err != nil {
		fmt.Fprintf(stderr, "h3yun login: %v\n", err)
		return 1
	}

	if *jsonOutput {
		output := struct {
			Authenticated bool      `json:"authenticated"`
			Provider      string    `json:"provider"`
			CorpID        string    `json:"corpId"`
			UserID        string    `json:"userId"`
			UnionID       string    `json:"unionId"`
			OpenID        string    `json:"openId"`
			Name          string    `json:"name"`
			SessionExpiry time.Time `json:"sessionExpiresAt"`
			H3YunIdentity string    `json:"h3yunIdentity"`
		}{
			Authenticated: true,
			Provider:      result.Principal.Provider,
			CorpID:        result.Principal.CorpID,
			UserID:        result.Principal.UserID,
			UnionID:       result.Principal.UnionID,
			OpenID:        result.Principal.OpenID,
			Name:          result.Principal.Name,
			SessionExpiry: result.ExpiresAt,
			H3YunIdentity: "not_mapped",
		}
		if err := json.NewEncoder(stdout).Encode(output); err != nil {
			return reportOutputError("h3yun login", err, stderr)
		}
		return 0
	}

	if _, err := fmt.Fprintf(stdout,
		"DingTalk authentication succeeded.\nEmployee: %s\ncorpId: %s\nuserId: %s\nunionId: %s\nopenId: %s\nSession expires at: %s\nH3Yun identity: not mapped\n",
		result.Principal.Name,
		result.Principal.CorpID,
		result.Principal.UserID,
		result.Principal.UnionID,
		result.Principal.OpenID,
		result.ExpiresAt.Format(time.RFC3339),
	); err != nil {
		return reportOutputError("h3yun login", err, stderr)
	}
	return 0
}
