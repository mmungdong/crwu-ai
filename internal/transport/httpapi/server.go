// Package httpapi exposes the CRWU server's host-neutral authentication API.
package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/mmungdong/crwu-ai/internal/auth"
)

const loginPath = "/v1/auth/h3yun/login"

type DingTalkOAuth interface {
	AuthorizationURL(state string) string
	ExchangeUser(ctx context.Context, code string) (auth.Principal, error)
}

type ServerConfig struct {
	OAuth      DingTalkOAuth
	Now        func() time.Time
	Random     io.Reader
	FlowTTL    time.Duration
	SessionTTL time.Duration
}

type Server struct {
	oauth      DingTalkOAuth
	now        func() time.Time
	random     io.Reader
	flowTTL    time.Duration
	sessionTTL time.Duration

	mu          sync.Mutex
	flows       map[string]*loginFlow
	flowByState map[string]string
	sessions    map[string]auth.Session
	handler     http.Handler
}

type loginFlow struct {
	id        string
	state     string
	status    string
	expiresAt time.Time
	principal auth.Principal
	session   auth.Session
	errorCode string
	errorText string
}

func NewServer(config ServerConfig) (*Server, error) {
	if config.OAuth == nil {
		return nil, errors.New("DingTalk OAuth client is required")
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	random := config.Random
	if random == nil {
		random = rand.Reader
	}
	flowTTL := config.FlowTTL
	if flowTTL <= 0 {
		flowTTL = 5 * time.Minute
	}
	sessionTTL := config.SessionTTL
	if sessionTTL <= 0 {
		sessionTTL = time.Hour
	}

	server := &Server{
		oauth:       config.OAuth,
		now:         now,
		random:      random,
		flowTTL:     flowTTL,
		sessionTTL:  sessionTTL,
		flows:       make(map[string]*loginFlow),
		flowByState: make(map[string]string),
		sessions:    make(map[string]auth.Session),
	}
	mux := http.NewServeMux()
	mux.HandleFunc(loginPath, server.handleStartLogin)
	mux.HandleFunc(loginPath+"/", server.handlePollLogin)
	mux.HandleFunc("/oauth/dingtalk/callback", server.handleDingTalkCallback)
	server.handler = securityHeaders(mux)
	return server, nil
}

func (s *Server) Handler() http.Handler {
	return s.handler
}

func (s *Server) handleStartLogin(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		methodNotAllowed(writer, http.MethodPost)
		return
	}
	flowID, err := s.randomValue()
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "random_generation_failed", "Could not start login.")
		return
	}
	state, err := s.randomValue()
	if err != nil {
		writeError(writer, http.StatusInternalServerError, "random_generation_failed", "Could not start login.")
		return
	}

	flow := &loginFlow{
		id:        flowID,
		state:     state,
		status:    "pending",
		expiresAt: s.now().Add(s.flowTTL),
	}
	s.mu.Lock()
	s.flows[flowID] = flow
	s.flowByState[state] = flowID
	s.mu.Unlock()

	writeJSON(writer, http.StatusCreated, map[string]any{
		"flowId":           flow.id,
		"authorizationUrl": s.oauth.AuthorizationURL(state),
		"expiresAt":        flow.expiresAt,
		"pollAfterSeconds": 2,
	})
}

func (s *Server) handlePollLogin(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		methodNotAllowed(writer, http.MethodGet)
		return
	}
	flowID := strings.TrimPrefix(request.URL.Path, loginPath+"/")
	if flowID == "" || strings.Contains(flowID, "/") {
		writeError(writer, http.StatusNotFound, "flow_not_found", "Login flow was not found.")
		return
	}

	s.mu.Lock()
	flow, ok := s.flows[flowID]
	if ok && !s.now().Before(flow.expiresAt) {
		delete(s.flowByState, flow.state)
		delete(s.flows, flowID)
		ok = false
	}
	if !ok {
		s.mu.Unlock()
		writeError(writer, http.StatusNotFound, "flow_not_found", "Login flow was not found or has expired.")
		return
	}
	status := flow.status
	principal := flow.principal
	session := flow.session
	errorCode := flow.errorCode
	errorText := flow.errorText
	s.mu.Unlock()

	switch status {
	case "pending", "processing":
		writeJSON(writer, http.StatusOK, map[string]string{"state": "pending"})
	case "authenticated":
		writeJSON(writer, http.StatusOK, map[string]any{
			"state":     "authenticated",
			"principal": principal,
			"session":   session,
		})
	case "failed":
		writeJSON(writer, http.StatusOK, map[string]string{
			"state":        "failed",
			"errorCode":    errorCode,
			"errorMessage": errorText,
		})
	default:
		writeError(writer, http.StatusInternalServerError, "invalid_flow_state", "Login flow is invalid.")
	}
}

func (s *Server) handleDingTalkCallback(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		methodNotAllowed(writer, http.MethodGet)
		return
	}
	state := request.URL.Query().Get("state")
	if state == "" {
		writeCallbackError(writer, http.StatusBadRequest, "Missing login state.")
		return
	}

	s.mu.Lock()
	flowID, ok := s.flowByState[state]
	flow := s.flows[flowID]
	if !ok || flow == nil || flow.status != "pending" || !s.now().Before(flow.expiresAt) {
		s.mu.Unlock()
		writeCallbackError(writer, http.StatusBadRequest, "Login state is invalid or expired.")
		return
	}
	delete(s.flowByState, state)
	flow.status = "processing"
	s.mu.Unlock()

	if request.URL.Query().Get("error") != "" {
		s.failFlow(flowID, "access_denied", "DingTalk authorization was denied.")
		writeCallbackError(writer, http.StatusForbidden, "DingTalk authorization was denied.")
		return
	}
	code := request.URL.Query().Get("authCode")
	if code == "" {
		code = request.URL.Query().Get("code")
	}
	if code == "" {
		s.failFlow(flowID, "missing_authorization_code", "DingTalk did not return an authorization code.")
		writeCallbackError(writer, http.StatusBadRequest, "Missing DingTalk authorization code.")
		return
	}

	principal, err := s.oauth.ExchangeUser(request.Context(), code)
	if err != nil {
		s.failFlow(flowID, "dingtalk_identity_failed", "DingTalk could not verify this employee.")
		writeCallbackError(writer, http.StatusBadGateway, "DingTalk could not verify this employee.")
		return
	}
	accessToken, err := s.randomValue()
	if err != nil {
		s.failFlow(flowID, "session_creation_failed", "Could not create the CRWU session.")
		writeCallbackError(writer, http.StatusInternalServerError, "Could not create the CRWU session.")
		return
	}
	session := auth.Session{
		AccessToken: accessToken,
		ExpiresAt:   s.now().Add(s.sessionTTL),
		Principal:   principal,
	}

	s.mu.Lock()
	if activeFlow := s.flows[flowID]; activeFlow != nil {
		activeFlow.status = "authenticated"
		activeFlow.principal = principal
		activeFlow.session = session
		s.sessions[accessToken] = session
	}
	s.mu.Unlock()

	writer.Header().Set("Content-Type", "text/html; charset=utf-8")
	writer.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(writer, "<!doctype html><title>CRWU login</title><p>DingTalk login succeeded. You may close this window.</p>")
}

func (s *Server) failFlow(flowID, code, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if flow := s.flows[flowID]; flow != nil {
		flow.status = "failed"
		flow.errorCode = code
		flow.errorText = message
	}
}

func (s *Server) randomValue() (string, error) {
	buffer := make([]byte, 32)
	if _, err := io.ReadFull(s.random, buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Cache-Control", "no-store")
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		writer.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		next.ServeHTTP(writer, request)
	})
}

func methodNotAllowed(writer http.ResponseWriter, allowed string) {
	writer.Header().Set("Allow", allowed)
	writeError(writer, http.StatusMethodNotAllowed, "method_not_allowed", "HTTP method is not allowed.")
}

func writeError(writer http.ResponseWriter, status int, code, message string) {
	writeJSON(writer, status, map[string]string{"errorCode": code, "errorMessage": message})
}

func writeCallbackError(writer http.ResponseWriter, status int, message string) {
	writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
	writer.WriteHeader(status)
	_, _ = io.WriteString(writer, message)
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}
