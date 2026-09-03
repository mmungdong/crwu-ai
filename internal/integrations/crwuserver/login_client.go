// Package crwuserver contains clients for the CRWU service boundary.
package crwuserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/mmungdong/crwu-ai/internal/app/h3yunlogin"
	"github.com/mmungdong/crwu-ai/internal/auth"
)

const maxLoginResponseBytes = 1 << 20

type LoginClient struct {
	httpClient *http.Client
}

func NewLoginClient(httpClient *http.Client) *LoginClient {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 15 * time.Second}
	}
	return &LoginClient{httpClient: httpClient}
}

func (c *LoginClient) Start(ctx context.Context, serverURL string) (h3yunlogin.Flow, error) {
	baseURL, err := validateServerURL(serverURL)
	if err != nil {
		return h3yunlogin.Flow{}, err
	}
	var response struct {
		FlowID           string    `json:"flowId"`
		AuthorizationURL string    `json:"authorizationUrl"`
		ExpiresAt        time.Time `json:"expiresAt"`
		PollAfterSeconds int       `json:"pollAfterSeconds"`
	}
	if err := c.call(ctx, http.MethodPost, baseURL+"/v1/auth/h3yun/login", &response); err != nil {
		return h3yunlogin.Flow{}, err
	}
	if response.FlowID == "" || response.AuthorizationURL == "" || response.ExpiresAt.IsZero() {
		return h3yunlogin.Flow{}, errors.New("CRWU server returned an incomplete login flow")
	}
	return h3yunlogin.Flow{
		ID:               response.FlowID,
		AuthorizationURL: response.AuthorizationURL,
		ExpiresAt:        response.ExpiresAt,
		PollAfter:        time.Duration(response.PollAfterSeconds) * time.Second,
	}, nil
}

func (c *LoginClient) Poll(ctx context.Context, serverURL, flowID string) (h3yunlogin.PollResult, error) {
	baseURL, err := validateServerURL(serverURL)
	if err != nil {
		return h3yunlogin.PollResult{}, err
	}
	if strings.TrimSpace(flowID) == "" {
		return h3yunlogin.PollResult{}, errors.New("login flow ID is required")
	}
	var response struct {
		State        h3yunlogin.State `json:"state"`
		Principal    auth.Principal   `json:"principal"`
		Session      auth.Session     `json:"session"`
		ErrorCode    string           `json:"errorCode"`
		ErrorMessage string           `json:"errorMessage"`
	}
	endpoint := baseURL + "/v1/auth/h3yun/login/" + url.PathEscape(flowID)
	if err := c.call(ctx, http.MethodGet, endpoint, &response); err != nil {
		return h3yunlogin.PollResult{}, err
	}
	return h3yunlogin.PollResult{
		State:        response.State,
		Principal:    response.Principal,
		Session:      response.Session,
		ErrorCode:    response.ErrorCode,
		ErrorMessage: response.ErrorMessage,
	}, nil
}

func (c *LoginClient) call(ctx context.Context, method, endpoint string, destination any) error {
	request, err := http.NewRequestWithContext(ctx, method, endpoint, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	response, err := c.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("call CRWU server: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var serverError struct {
			Code    string `json:"errorCode"`
			Message string `json:"errorMessage"`
		}
		_ = json.NewDecoder(io.LimitReader(response.Body, maxLoginResponseBytes)).Decode(&serverError)
		if serverError.Message == "" {
			serverError.Message = http.StatusText(response.StatusCode)
		}
		return fmt.Errorf("CRWU server returned HTTP %d: %s (%s)", response.StatusCode, serverError.Message, serverError.Code)
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, maxLoginResponseBytes)).Decode(destination); err != nil {
		return fmt.Errorf("decode CRWU server response: %w", err)
	}
	return nil
}

func validateServerURL(value string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("valid CRWU server URL is required")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return "", errors.New("CRWU server URL must contain only a scheme and host")
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && isLoopbackHost(parsed.Hostname())) {
		return "", errors.New("CRWU server URL must use HTTPS; HTTP is allowed only for localhost")
	}
	return strings.TrimRight(parsed.String(), "/"), nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
