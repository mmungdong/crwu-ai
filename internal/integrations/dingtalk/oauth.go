// Package dingtalk owns DingTalk-specific OAuth and API details.
package dingtalk

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	defaultAuthorizationEndpoint = "https://login.dingtalk.com/oauth2/auth"
	defaultAPIBaseURL            = "https://api.dingtalk.com"
	defaultLegacyAPIBaseURL      = "https://oapi.dingtalk.com"
	maxResponseBytes             = 1 << 20
)

type OAuthConfig struct {
	ClientID              string
	ClientSecret          string
	CorpID                string
	RedirectURL           string
	AuthorizationEndpoint string
	APIBaseURL            string
	LegacyAPIBaseURL      string
	HTTPClient            *http.Client
}

type OAuthClient struct {
	clientID              string
	clientSecret          string
	corpID                string
	redirectURL           string
	authorizationEndpoint string
	apiBaseURL            string
	legacyAPIBaseURL      string
	httpClient            *http.Client
}

type Identity struct {
	CorpID  string
	UserID  string
	UnionID string
	OpenID  string
	Name    string
}

type ProviderSession struct {
	AccessToken  string
	RefreshToken string
	ExpiresIn    time.Duration
}

func NewOAuthClient(config OAuthConfig) (*OAuthClient, error) {
	if strings.TrimSpace(config.ClientID) == "" {
		return nil, errors.New("DingTalk client ID is required")
	}
	if strings.TrimSpace(config.ClientSecret) == "" {
		return nil, errors.New("DingTalk client secret is required")
	}
	if strings.TrimSpace(config.CorpID) == "" {
		return nil, errors.New("DingTalk corp ID is required")
	}
	redirect, err := url.Parse(config.RedirectURL)
	if err != nil || redirect.Scheme == "" || redirect.Host == "" {
		return nil, errors.New("valid DingTalk redirect URL is required")
	}

	authorizationEndpoint := config.AuthorizationEndpoint
	if authorizationEndpoint == "" {
		authorizationEndpoint = defaultAuthorizationEndpoint
	}
	apiBaseURL := strings.TrimRight(config.APIBaseURL, "/")
	if apiBaseURL == "" {
		apiBaseURL = defaultAPIBaseURL
	}
	legacyAPIBaseURL := strings.TrimRight(config.LegacyAPIBaseURL, "/")
	if legacyAPIBaseURL == "" {
		legacyAPIBaseURL = defaultLegacyAPIBaseURL
	}
	httpClient := config.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 15 * time.Second}
	}

	return &OAuthClient{
		clientID:              config.ClientID,
		clientSecret:          config.ClientSecret,
		corpID:                config.CorpID,
		redirectURL:           config.RedirectURL,
		authorizationEndpoint: authorizationEndpoint,
		apiBaseURL:            apiBaseURL,
		legacyAPIBaseURL:      legacyAPIBaseURL,
		httpClient:            httpClient,
	}, nil
}

func (c *OAuthClient) AuthorizationURL(state string) string {
	values := url.Values{
		"redirect_uri":  {c.redirectURL},
		"response_type": {"code"},
		"client_id":     {c.clientID},
		"scope":         {"openid"},
		"state":         {state},
		"prompt":        {"consent"},
	}
	return c.authorizationEndpoint + "?" + values.Encode()
}

func (c *OAuthClient) ExchangeUser(ctx context.Context, code string) (Identity, ProviderSession, error) {
	if strings.TrimSpace(code) == "" {
		return Identity{}, ProviderSession{}, errors.New("DingTalk authorization code is required")
	}

	requestBody := map[string]string{
		"clientId":     c.clientID,
		"clientSecret": c.clientSecret,
		"code":         code,
		"grantType":    "authorization_code",
	}
	var tokenResponse struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		ExpireIn     int64  `json:"expireIn"`
		CorpID       string `json:"corpId"`
	}
	if err := c.callJSON(ctx, http.MethodPost, c.apiBaseURL+"/v1.0/oauth2/userAccessToken", requestBody, "", &tokenResponse); err != nil {
		return Identity{}, ProviderSession{}, fmt.Errorf("exchange DingTalk authorization code: %w", err)
	}
	if tokenResponse.AccessToken == "" {
		return Identity{}, ProviderSession{}, errors.New("DingTalk token response did not include an access token")
	}
	if tokenResponse.CorpID != c.corpID {
		return Identity{}, ProviderSession{}, fmt.Errorf("DingTalk employee belongs to corpId %q, expected configured organization", tokenResponse.CorpID)
	}

	var userResponse struct {
		Nick    string `json:"nick"`
		OpenID  string `json:"openId"`
		UnionID string `json:"unionId"`
	}
	if err := c.callJSON(ctx, http.MethodGet, c.apiBaseURL+"/v1.0/contact/users/me", nil, tokenResponse.AccessToken, &userResponse); err != nil {
		return Identity{}, ProviderSession{}, fmt.Errorf("get DingTalk employee profile: %w", err)
	}
	if tokenResponse.CorpID == "" || userResponse.UnionID == "" || userResponse.OpenID == "" {
		return Identity{}, ProviderSession{}, errors.New("DingTalk response did not include corpId, unionId, and openId")
	}

	var appTokenResponse struct {
		AccessToken string `json:"accessToken"`
	}
	if err := c.callJSON(ctx, http.MethodPost, c.apiBaseURL+"/v1.0/oauth2/accessToken", map[string]string{
		"appKey":    c.clientID,
		"appSecret": c.clientSecret,
	}, "", &appTokenResponse); err != nil {
		return Identity{}, ProviderSession{}, fmt.Errorf("get DingTalk organization token: %w", err)
	}
	if appTokenResponse.AccessToken == "" {
		return Identity{}, ProviderSession{}, errors.New("DingTalk organization token response did not include an access token")
	}

	var userIDResponse struct {
		ErrorCode int `json:"errcode"`
		Result    struct {
			UserID string `json:"userid"`
		} `json:"result"`
	}
	userIDEndpoint := c.legacyAPIBaseURL + "/topapi/user/getbyunionid?access_token=" + url.QueryEscape(appTokenResponse.AccessToken)
	if err := c.callJSON(ctx, http.MethodPost, userIDEndpoint, map[string]string{"unionid": userResponse.UnionID}, "", &userIDResponse); err != nil {
		return Identity{}, ProviderSession{}, fmt.Errorf("resolve DingTalk organization user ID: %w", err)
	}
	if userIDResponse.ErrorCode != 0 {
		return Identity{}, ProviderSession{}, fmt.Errorf("resolve DingTalk organization user ID: DingTalk error %d", userIDResponse.ErrorCode)
	}
	if userIDResponse.Result.UserID == "" {
		return Identity{}, ProviderSession{}, errors.New("DingTalk response did not include an organization userId")
	}

	return Identity{
		CorpID:  tokenResponse.CorpID,
		UserID:  userIDResponse.Result.UserID,
		UnionID: userResponse.UnionID,
		OpenID:  userResponse.OpenID,
		Name:    userResponse.Nick,
	}, ProviderSession{
		AccessToken:  tokenResponse.AccessToken,
		RefreshToken: tokenResponse.RefreshToken,
		ExpiresIn:    time.Duration(tokenResponse.ExpireIn) * time.Second,
	}, nil
}

func (c *OAuthClient) callJSON(ctx context.Context, method, endpoint string, body any, accessToken string, destination any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if accessToken != "" {
		request.Header.Set("x-acs-dingtalk-access-token", accessToken)
	}

	response, err := c.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("DingTalk API returned HTTP %d", response.StatusCode)
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, maxResponseBytes))
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("decode DingTalk response: %w", err)
	}
	return nil
}
