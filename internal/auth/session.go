package auth

import (
	"context"
	"time"
)

// Principal is the employee identity authenticated by CRWU. It never represents
// an application, administrator, or H3Yun engine credential.
type Principal struct {
	Provider string `json:"provider"`
	CorpID   string `json:"corpId"`
	UserID   string `json:"userId"`
	UnionID  string `json:"unionId"`
	OpenID   string `json:"openId"`
	Name     string `json:"name"`
}

// Session contains an opaque CRWU credential. Provider access and refresh
// tokens must never be placed in this value.
type Session struct {
	AccessToken string    `json:"accessToken"`
	ExpiresAt   time.Time `json:"expiresAt"`
	Principal   Principal `json:"principal"`
}

// SessionStore persists a CRWU session for one server without exposing how the
// operating system protects it.
type SessionStore interface {
	Save(ctx context.Context, serverURL string, session Session) error
}
