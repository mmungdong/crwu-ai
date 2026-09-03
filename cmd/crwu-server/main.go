package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/mmungdong/crwu-ai/internal/auth"
	"github.com/mmungdong/crwu-ai/internal/config"
	"github.com/mmungdong/crwu-ai/internal/integrations/dingtalk"
	"github.com/mmungdong/crwu-ai/internal/transport/httpapi"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	configuration, err := config.LoadServer(os.Getenv)
	if err != nil {
		return fmt.Errorf("load server configuration: %w", err)
	}
	oauth, err := dingtalk.NewOAuthClient(dingtalk.OAuthConfig{
		ClientID:     configuration.DingTalk.ClientID,
		ClientSecret: configuration.DingTalk.ClientSecret,
		CorpID:       configuration.DingTalk.CorpID,
		RedirectURL:  configuration.DingTalk.RedirectURL,
	})
	if err != nil {
		return fmt.Errorf("configure DingTalk OAuth: %w", err)
	}
	api, err := httpapi.NewServer(httpapi.ServerConfig{OAuth: dingTalkOAuthAdapter{client: oauth}})
	if err != nil {
		return fmt.Errorf("configure CRWU HTTP API: %w", err)
	}
	server := &http.Server{
		Addr:              configuration.Addr,
		Handler:           api.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	log.Printf("crwu-server listening on %s", configuration.Addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

type dingTalkOAuthAdapter struct {
	client *dingtalk.OAuthClient
}

func (a dingTalkOAuthAdapter) AuthorizationURL(state string) string {
	return a.client.AuthorizationURL(state)
}

func (a dingTalkOAuthAdapter) ExchangeUser(ctx context.Context, code string) (auth.Principal, error) {
	identity, _, err := a.client.ExchangeUser(ctx, code)
	if err != nil {
		return auth.Principal{}, err
	}
	return auth.Principal{
		Provider: "dingtalk",
		CorpID:   identity.CorpID,
		UserID:   identity.UserID,
		UnionID:  identity.UnionID,
		OpenID:   identity.OpenID,
		Name:     identity.Name,
	}, nil
}
