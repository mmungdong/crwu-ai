package browser

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"
)

// PageFacts is the small set of page facts the rest of the package reasons about.
type PageFacts struct {
	Href  string
	Title string
	Text  string
}

// defaultViewport matches the window the browser is launched with, so a
// screenshot before any explicit resize looks like what the employee would see.
const (
	defaultViewportWidth  = 1440
	defaultViewportHeight = 1000
)

// scrollStep is how far each scroll step advances. Small enough that lazy-loaded
// rows materialise, large enough that a long page does not take forever.
const scrollStep = 700

// factsExpression gathers the page facts in one round trip.
const factsExpression = `JSON.stringify({href:location.href,title:document.title,text:(document.body?document.body.innerText:"").replace(/\s+/g," ")})`

// ScrollScript walks the whole page and returns to the top.
//
// Scrolling first is not optional for a screenshot: content below the fold is
// lazy-rendered, and capturing without it yields a long image whose lower half is
// placeholder boxes. Returning to the top keeps the viewport predictable for the
// caller.
func ScrollScript() string {
	return fmt.Sprintf(`(async()=>{const H=document.body.scrollHeight;for(let y=0;y<H;y+=%d){window.scrollTo(0,y);await new Promise(r=>setTimeout(r,220));}window.scrollTo(0,0);})()`, scrollStep)
}

// SetViewport overrides the emulated device metrics.
func (c *Client) SetViewport(ctx context.Context, width, height int) error {
	_, err := c.Call(ctx, "Emulation.setDeviceMetricsOverride", map[string]any{
		"width": width, "height": height, "deviceScaleFactor": 1, "mobile": false,
	})
	return err
}

// ScrollAll runs ScrollScript in the page.
func (c *Client) ScrollAll(ctx context.Context) error {
	_, err := c.Call(ctx, "Runtime.evaluate", map[string]any{
		"expression": ScrollScript(), "awaitPromise": true,
	})
	return err
}

// Facts reads the current page facts.
//
// An unparseable payload is an error rather than a partially-filled struct: a
// caller that receives a zero Href must be able to tell "the page said nothing"
// from "we failed to read it".
func (c *Client) Facts(ctx context.Context) (PageFacts, error) {
	raw, err := c.Call(ctx, "Runtime.evaluate", map[string]any{
		"expression": factsExpression, "returnByValue": true,
	})
	if err != nil {
		return PageFacts{}, err
	}
	var payload struct {
		Result struct {
			Value string `json:"value"`
		} `json:"result"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return PageFacts{}, fmt.Errorf("解析页面事实失败：%w", err)
	}
	var facts PageFacts
	if err := json.Unmarshal([]byte(payload.Result.Value), &facts); err != nil {
		return PageFacts{}, fmt.Errorf("页面返回的事实不是合法 JSON：%w", err)
	}
	return facts, nil
}

// OuterHTML returns the rendered DOM.
//
// It is the rendered document, not the original response body: site data that the
// caller parses is frequently injected after load.
func (c *Client) OuterHTML(ctx context.Context) (string, error) {
	raw, err := c.Call(ctx, "Runtime.evaluate", map[string]any{
		"expression": "document.documentElement.outerHTML", "returnByValue": true,
	})
	if err != nil {
		return "", err
	}
	var payload struct {
		Result struct {
			Value string `json:"value"`
		} `json:"result"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", fmt.Errorf("解析 DOM 失败：%w", err)
	}
	return payload.Result.Value, nil
}

// Navigate points the tab at url and waits for the document to become readable.
//
// It polls the page facts rather than waiting for a load event: single-page sites
// can finish a navigation without the event the caller would be waiting on.
func (c *Client) Navigate(ctx context.Context, url string) error {
	if _, err := c.Call(ctx, "Page.navigate", map[string]any{"url": url}); err != nil {
		return err
	}
	deadline := time.Now().Add(navigationTimeout)
	for {
		if facts, err := c.Facts(ctx); err == nil && facts.Href != "" {
			return nil
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("导航到 %s 后页面没有变为可读", url)
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("导航到 %s 被取消：%w", url, ctx.Err())
		case <-time.After(150 * time.Millisecond):
		}
	}
}

// navigationTimeout bounds how long Navigate waits for a readable document.
const navigationTimeout = 30 * time.Second

// maxCaptureHeight caps a full-page capture. Some pages set a scroll height in the
// tens of thousands of pixels; an unbounded capture is a memory spike for an image
// nobody can read.
const maxCaptureHeight = 16000

// Screenshot captures the page and returns the PNG bytes.
//
// `fullPage` measures the rendered content and captures beyond the viewport. It is
// a parameter rather than a constant because forcing the emulated viewport to the
// full content height re-lays-out the page, which is both slower and a change to
// what is being measured; a caller that only needs the fold should not pay it.
func (c *Client) Screenshot(ctx context.Context, fullPage bool) ([]byte, error) {
	params := map[string]any{"format": "png"}
	if fullPage {
		height, err := c.contentHeight(ctx)
		if err != nil {
			return nil, err
		}
		if err := c.SetViewport(ctx, defaultViewportWidth, height); err != nil {
			return nil, err
		}
		params["captureBeyondViewport"] = true
	}
	raw, err := c.Call(ctx, "Page.captureScreenshot", params)
	if err != nil {
		return nil, err
	}
	var payload struct {
		Data string `json:"data"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, fmt.Errorf("解析截图响应失败：%w", err)
	}
	decoded, err := base64.StdEncoding.DecodeString(payload.Data)
	if err != nil {
		return nil, fmt.Errorf("解码截图失败：%w", err)
	}
	return decoded, nil
}

// contentHeight reads the rendered content height, clamped to maxCaptureHeight.
func (c *Client) contentHeight(ctx context.Context) (int, error) {
	raw, err := c.Call(ctx, "Page.getLayoutMetrics", nil)
	if err != nil {
		return 0, err
	}
	var metrics struct {
		CSSContentSize struct {
			Height float64 `json:"height"`
		} `json:"cssContentSize"`
	}
	if err := json.Unmarshal(raw, &metrics); err != nil {
		return 0, fmt.Errorf("解析页面尺寸失败：%w", err)
	}
	height := int(metrics.CSSContentSize.Height)
	if height < defaultViewportHeight {
		height = defaultViewportHeight
	}
	if height > maxCaptureHeight {
		height = maxCaptureHeight
	}
	return height, nil
}
