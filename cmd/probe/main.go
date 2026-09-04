// Temporary grammar probe for the H3Yun web-console /v1/bizdata/query filter.
// It is deleted after use; never commit.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/mmungdong/crwu-ai/internal/integrations/h3yun"
	"github.com/mmungdong/crwu-ai/internal/platform/h3yuncreds"
)

func count(raw json.RawMessage) (string, error) {
	var w struct {
		ReturnData []json.RawMessage `json:"returnData"`
		DataCount  int               `json:"dataCount"`
	}
	if err := json.Unmarshal(raw, &w); err != nil {
		return "", fmt.Errorf("decode: %w", err)
	}
	return fmt.Sprintf("rows=%d total=%d", len(w.ReturnData), w.DataCount), nil
}

func main() {
	ctx := context.Background()
	store := h3yuncreds.NewStore()
	session, err := store.Load(ctx)
	if err != nil {
		fmt.Println("load session:", err)
		os.Exit(1)
	}
	client, err := h3yun.NewWebClient(h3yun.WebConfig{Token: session.Token, EngineCode: session.EngineCode})
	if err != nil {
		fmt.Println("client:", err)
		os.Exit(1)
	}

	schema := "Syxwvsuwmyagdm66hdtho11ux4"
	item := func(field, operator string, value any) map[string]any {
		return map[string]any{
			"type": "Item", "name": schema + "." + field,
			"operator": operator, "value": value, "matchers": []any{},
		}
	}
	and := func(items ...map[string]any) map[string]any {
		arr := make([]any, 0, len(items))
		for _, it := range items {
			arr = append(arr, it)
		}
		return map[string]any{"type": "And", "matchers": arr}
	}

	type trial struct {
		name string
		m    map[string]any
	}
	trials := []trial{
		{"Name Equal 润华有限公司", and(item("Name", "Equal", "润华有限公司"))},
		{"Name Like 润华", and(item("Name", "Like", "润华"))},
		{"Name Contains 润华", and(item("Name", "Contains", "润华"))},
		{"Name StartWith 润华", and(item("Name", "StartWith", "润华"))},
		{"Name In [润华有限公司, xx]", and(item("Name", "In", []string{"润华有限公司", "不存在之公司"}))},
		{"Name NotEqual 不存在", and(item("Name", "NotEqual", "不存在之公司"))},
		{"F0000036 Equal 国有企业", and(item("F0000036", "Equal", "国有企业"))},
		{"F0000036 Like 国有", and(item("F0000036", "Like", "国有"))},
		{"Status Equal 1", and(item("Status", "Equal", 1))},
		{"Status Above 0", and(item("Status", "Above", 0))},
		{"Status In [1]", and(item("Status", "In", []int{1}))},
		{"Name Equal 润华 AND F0000036 Equal 国有企业", and(item("Name", "Equal", "润华有限公司"), item("F0000036", "Equal", "国有企业"))},
	}
	for _, t := range trials {
		raw, err := client.QueryRecords(ctx, h3yun.QueryRecordsParams{
			SchemaCode: schema, PageIndex: 0, PageSize: 3, RequireCount: true,
			Filter: map[string]any{"matcher": t.m},
		})
		if err != nil {
			fmt.Printf("%-42s => ERROR %v\n", t.name, err)
			continue
		}
		c, err := count(raw)
		if err != nil {
			fmt.Printf("%-42s => PARSE %v\n", t.name, err)
			continue
		}
		fmt.Printf("%-42s => %s\n", t.name, c)
	}
}
