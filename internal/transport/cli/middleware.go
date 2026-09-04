package cli

import (
	"strings"

	"github.com/spf13/cobra"
)

// sessionRenewalMiddleware silently renews the employee web session before any
// session-dependent read command. Session-management commands and the agent
// (h3pat) channel skip the check.
func sessionRenewalMiddleware(web H3YunWebService) func(*cobra.Command, []string) error {
	return func(cmd *cobra.Command, _ []string) error {
		if web == nil {
			return nil
		}
		if len(cmd.Commands()) != 0 || !sessionDependentCommand(cmd.CommandPath()) {
			return nil
		}
		return web.EnsureFresh(cmd.Context())
	}
}

// sessionDependentCommand reports whether a command path needs a live web
// session renewal before it runs. Session management and the agent (h3pat)
// channel are excluded.
func sessionDependentCommand(path string) bool {
	switch path {
	case "crwu h3yun session", "crwu h3yun session login", "crwu h3yun session bind",
		"crwu h3yun session status", "crwu h3yun session refresh", "crwu h3yun session clear",
		"crwu h3yun ping", "crwu h3yun tools", "crwu h3yun apps search",
		"crwu h3yun records query":
		return false
	default:
		return strings.HasPrefix(path, "crwu h3yun ")
	}
}
