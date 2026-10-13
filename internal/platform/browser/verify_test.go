package browser

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"
)

func TestAuthCookiePresentRequiresNameDomainAndValue(t *testing.T) {
	site := Site{ID: "ke", AuthCookie: "lianjia_token", AuthDomains: []string{".ke.com"}}
	cases := []struct {
		name    string
		cookies []Cookie
		want    bool
	}{
		{"all three match", []Cookie{{Name: "lianjia_token", Domain: ".ke.com", Value: "v"}}, true},
		{"name matches but domain does not", []Cookie{{Name: "lianjia_token", Domain: ".lianjia.com", Value: "v"}}, false},
		{"domain matches but value is empty", []Cookie{{Name: "lianjia_token", Domain: ".ke.com", Value: ""}}, false},
		{"only a lookalike name", []Cookie{{Name: "lianjia_token_secure", Domain: ".ke.com", Value: "v"}}, false},
		{"no cookies at all", nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := AuthCookiePresent(tc.cookies, site); got != tc.want {
				t.Fatalf("AuthCookiePresent(%+v) = %v, want %v", tc.cookies, got, tc.want)
			}
		})
	}
}

func TestAuthCookiePresentWithoutDomainRestrictionAcceptsAnyDomain(t *testing.T) {
	site := Site{ID: "x", AuthCookie: "sess"}
	if !AuthCookiePresent([]Cookie{{Name: "sess", Domain: "whatever.example", Value: "v"}}, site) {
		t.Fatal("AuthCookiePresent() = false without AuthDomains, want any domain to count")
	}
}

func blankPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for x := 0; x < width; x++ {
		for y := 0; y < height; y++ {
			img.Set(x, y, color.RGBA{R: 255, G: 255, B: 255, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode blank png: %v", err)
	}
	return buf.Bytes()
}

func contentPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	// 上半部填充深色：非白占比 50%，远超阈值。
	for x := 0; x < width; x++ {
		for y := 0; y < height/2; y++ {
			img.Set(x, y, color.RGBA{R: 20, G: 20, B: 20, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode content png: %v", err)
	}
	return buf.Bytes()
}

func TestVerifyScreenshotRejectsBlankImage(t *testing.T) {
	err := VerifyScreenshot(blankPNG(t, 1440, 1200))
	if err == nil {
		t.Fatal("VerifyScreenshot() = nil error for an all-white image")
	}
	if !strings.Contains(err.Error(), "空白") {
		t.Fatalf("VerifyScreenshot() error = %q, want it to say the image is blank", err.Error())
	}
}

func TestVerifyScreenshotRejectsTinyImage(t *testing.T) {
	err := VerifyScreenshot(contentPNG(t, 10, 10))
	if err == nil {
		t.Fatal("VerifyScreenshot() = nil error for a 10x10 image")
	}
	if !strings.Contains(err.Error(), "尺寸") {
		t.Fatalf("VerifyScreenshot() error = %q, want it to mention the size", err.Error())
	}
}

func TestVerifyScreenshotAcceptsAPageLikeImage(t *testing.T) {
	if err := VerifyScreenshot(contentPNG(t, 1440, 1200)); err != nil {
		t.Fatalf("VerifyScreenshot() error = %v, want nil for an image with content", err)
	}
}

func TestVerifyScreenshotRejectsNonPNG(t *testing.T) {
	err := VerifyScreenshot([]byte("this is not a png"))
	if err == nil {
		t.Fatal("VerifyScreenshot() = nil error for undecodable bytes")
	}
}
