package browser

import (
	"reflect"
	"testing"
)

func TestOpenerUsesNativeCommandForMacOSAndWindows(t *testing.T) {
	tests := []struct {
		name     string
		goos     string
		wantName string
		wantArgs []string
	}{
		{name: "macOS", goos: "darwin", wantName: "open", wantArgs: []string{"https://login.example"}},
		{name: "Windows", goos: "windows", wantName: "rundll32", wantArgs: []string{"url.dll,FileProtocolHandler", "https://login.example"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var gotName string
			var gotArgs []string
			opener := newOpener(test.goos, func(name string, args ...string) error {
				gotName = name
				gotArgs = args
				return nil
			})
			if err := opener.Open("https://login.example"); err != nil {
				t.Fatalf("Open() error = %v", err)
			}
			if gotName != test.wantName || !reflect.DeepEqual(gotArgs, test.wantArgs) {
				t.Fatalf("command = %q %v, want %q %v", gotName, gotArgs, test.wantName, test.wantArgs)
			}
		})
	}
}
