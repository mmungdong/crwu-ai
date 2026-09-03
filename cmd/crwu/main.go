package main

import (
	"net/http"
	"os"
	"time"

	"github.com/mmungdong/crwu-ai/internal/app/h3yunlogin"
	"github.com/mmungdong/crwu-ai/internal/app/h3yunops"
	"github.com/mmungdong/crwu-ai/internal/app/h3yunweb"
	"github.com/mmungdong/crwu-ai/internal/auth"
	"github.com/mmungdong/crwu-ai/internal/integrations/crwuserver"
	"github.com/mmungdong/crwu-ai/internal/platform/browser"
	"github.com/mmungdong/crwu-ai/internal/transport/cli"
)

func main() {
	login := &h3yunlogin.Service{
		Gateway:  crwuserver.NewLoginClient(&http.Client{Timeout: 15 * time.Second}),
		Opener:   browser.NewOpener(),
		Sessions: auth.NewKeyringStore(),
	}
	os.Exit(cli.RunWithDependencies(os.Args[1:], os.Stdout, os.Stderr, cli.Dependencies{
		H3YunLogin: login,
		H3YunOps:   h3yunops.EnvService(os.Getenv),
		H3YunWeb:   h3yunweb.EnvService(os.Getenv),
		Getenv:     os.Getenv,
	}))
}
