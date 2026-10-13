package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/gorilla/websocket"
)

// Client is a minimal Chrome DevTools Protocol client over one websocket.
//
// It exists as its own type rather than reusing `internal/platform/scanlogin`'s
// client because that one is welded to the H3Yun session capture: pulling it out
// would mean editing a login path that is already verified in production. The
// duplicated surface is one request/response pair, which is a cheaper price than
// destabilising the H3Yun login.
type Client struct {
	conn *websocket.Conn
	// mu serialises a whole request/response cycle. It must span the read as well
	// as the write: a CDP connection carries one response at a time, so two
	// concurrent Callers would otherwise consume each other's replies.
	mu   sync.Mutex
	next int
}

// Cookie is the part of a CDP cookie this package needs.
//
// Only name/domain/value are kept. The value is a credential: it is used for
// presence checks and must never reach output, logs, or an error message.
type Cookie struct {
	Name   string
	Domain string
	Value  string
}

// Dial connects to a target's websocket debugger URL.
func Dial(ctx context.Context, wsURL string) (*Client, error) {
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, wsURL, nil)
	if err != nil {
		return nil, fmt.Errorf("连接调试端点失败：%w", err)
	}
	return &Client{conn: conn}, nil
}

// Close releases the websocket.
func (c *Client) Close() error {
	return c.conn.Close()
}

// Call sends one CDP command and returns the matching response's result.
//
// Messages whose id does not match are skipped: the connection carries events and
// replies to earlier commands, and returning one of those would silently attribute
// another command's result to this one.
func (c *Client) Call(ctx context.Context, method string, params map[string]any) (json.RawMessage, error) {
	if params == nil {
		params = map[string]any{}
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	c.next++
	id := c.next
	payload, err := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	if err != nil {
		return nil, fmt.Errorf("序列化 CDP 请求失败：%w", err)
	}

	// A cancelled context has to unblock the read below, and the only way to
	// interrupt a websocket read is to close the connection.
	if done := ctx.Done(); done != nil {
		stop := make(chan struct{})
		defer close(stop)
		go func() {
			select {
			case <-done:
				_ = c.conn.Close()
			case <-stop:
			}
		}()
	}

	if err := c.conn.WriteMessage(websocket.TextMessage, payload); err != nil {
		return nil, fmt.Errorf("发送 CDP %s 失败：%w", method, err)
	}

	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return nil, fmt.Errorf("CDP %s 被取消：%w", method, ctxErr)
			}
			return nil, fmt.Errorf("读取 CDP %s 响应失败：%w", method, err)
		}
		var message struct {
			ID     int             `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(raw, &message); err != nil {
			continue
		}
		if message.ID != id {
			continue
		}
		if message.Error != nil {
			return nil, fmt.Errorf("CDP %s: %s", method, message.Error.Message)
		}
		return message.Result, nil
	}
}

// Cookies returns every cookie the browser currently holds.
//
// It deliberately passes no `urls` filter: the caller needs to see the session
// across the whole site, and a filtered read is how "signed out" gets mistaken for
// "signed in somewhere else".
func (c *Client) Cookies(ctx context.Context) ([]Cookie, error) {
	raw, err := c.Call(ctx, "Network.getCookies", nil)
	if err != nil {
		return nil, err
	}
	var payload struct {
		Cookies []struct {
			Name   string `json:"name"`
			Domain string `json:"domain"`
			Value  string `json:"value"`
		} `json:"cookies"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, fmt.Errorf("解析 cookie 响应失败：%w", err)
	}
	cookies := make([]Cookie, 0, len(payload.Cookies))
	for _, item := range payload.Cookies {
		cookies = append(cookies, Cookie{Name: item.Name, Domain: item.Domain, Value: item.Value})
	}
	return cookies, nil
}
