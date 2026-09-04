package cli

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

type schemeDocument struct {
	Version  string          `json:"version"`
	Commands []schemeCommand `json:"commands"`
}

type schemeCommand struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Usage       string          `json:"usage"`
	Examples    []schemeExample `json:"examples"`
}

type schemeExample struct {
	Description string `json:"description"`
	Command     string `json:"command"`
}

func TestRunSchemeWritesMachineReadableCommandCatalog(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := Run([]string{"scheme"}, &stdout, &stderr)

	if code != 0 {
		t.Fatalf("Run() exit code = %d, want 0; stderr = %q", code, stderr.String())
	}
	if stderr.Len() != 0 {
		t.Fatalf("stderr = %q, want empty", stderr.String())
	}

	var document schemeDocument
	if err := json.Unmarshal(stdout.Bytes(), &document); err != nil {
		t.Fatalf("scheme output is not valid JSON: %v\noutput: %s", err, stdout.String())
	}
	if document.Version != "0.0.1" {
		t.Fatalf("version = %q, want %q", document.Version, "0.0.1")
	}

	wantCommands := map[string]bool{
		"help":                  false,
		"h3yun ping":            false,
		"h3yun tools":           false,
		"h3yun session bind":    false,
		"h3yun session login":   false,
		"h3yun session status":  false,
		"h3yun session refresh": false,
		"h3yun session clear":   false,
		"h3yun apps search":     false,
		"h3yun apps list":       false,
		"h3yun apps children":   false,
		"h3yun forms search":    false,
		"h3yun records query":   false,
		"h3yun records list":    false,
		"h3yun records get":     false,
		"h3yun files list":      false,
		"h3yun file download":   false,
		"scheme":                false,
		"version":               false,
	}
	for _, command := range document.Commands {
		found, ok := wantCommands[command.Name]
		if !ok {
			t.Fatalf("unexpected command %q in scheme output", command.Name)
		}
		if found {
			t.Fatalf("duplicate command %q in scheme output", command.Name)
		}
		wantCommands[command.Name] = true
	}
	for name, found := range wantCommands {
		if !found {
			t.Errorf("command %q is missing from scheme output", name)
		}
	}
}

func TestSchemeDocumentsEveryCommandForAIClients(t *testing.T) {
	for _, command := range commandDefinitions() {
		if command.handler == nil {
			t.Fatalf("command %q has no handler", command.Name)
		}
	}

	var stdout, stderr bytes.Buffer
	if code := Run([]string{"scheme"}, &stdout, &stderr); code != 0 {
		t.Fatalf("Run() exit code = %d, want 0; stderr = %q", code, stderr.String())
	}

	var document schemeDocument
	if err := json.Unmarshal(stdout.Bytes(), &document); err != nil {
		t.Fatalf("scheme output is not valid JSON: %v", err)
	}

	for _, command := range document.Commands {
		t.Run(command.Name, func(t *testing.T) {
			wantPrefix := "crwu " + command.Name
			if command.Description == "" || !isASCII(command.Description) {
				t.Fatalf("description = %q, want non-empty English text", command.Description)
			}
			if !strings.HasPrefix(command.Usage, wantPrefix) {
				t.Fatalf("usage = %q, want prefix %q", command.Usage, wantPrefix)
			}
			if len(command.Examples) == 0 {
				t.Fatal("examples are empty, want at least one")
			}
			for i, example := range command.Examples {
				if example.Description == "" || !isASCII(example.Description) {
					t.Errorf("examples[%d].description = %q, want non-empty English text", i, example.Description)
				}
				if !strings.HasPrefix(example.Command, wantPrefix) {
					t.Errorf("examples[%d].command = %q, want prefix %q", i, example.Command, wantPrefix)
				}
			}
		})
	}
}

func isASCII(value string) bool {
	for _, r := range value {
		if r > 127 {
			return false
		}
	}
	return true
}
