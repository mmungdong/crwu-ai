package h3yun

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func mustPayload(t *testing.T, schemaCode, expr string) map[string]any {
	t.Helper()
	payload, err := BuildFilter(schemaCode, expr)
	if err != nil {
		t.Fatalf("BuildFilter(%q, %q) error = %v", schemaCode, expr, err)
	}
	return payload
}

func decode(t *testing.T, raw string) any {
	t.Helper()
	var decoded any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		t.Fatalf("decode expected payload: %v", err)
	}
	return decoded
}

func assertPayload(t *testing.T, got map[string]any, wantJSON string) {
	t.Helper()
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal got: %v", err)
	}
	if !reflect.DeepEqual(decode(t, string(encoded)), decode(t, wantJSON)) {
		t.Fatalf("payload mismatch:\n got: %s\nwant: %s", encoded, wantJSON)
	}
}

func TestBuildFilterScalarOperators(t *testing.T) {
	const schema = "Syxwvsuwmyagdm66hdtho11ux4"
	tests := []struct {
		expr string
		want string
	}{
		{
			expr: `Name Equal '润华有限公司'`,
			want: `{"matcher":{"type":"And","matchers":[{"type":"Item","name":"Syxwvsuwmyagdm66hdtho11ux4.Name","operator":"Equal","value":"润华有限公司","matchers":[]}]}}`,
		},
		{
			expr: `Status = 1`,
			want: `{"matcher":{"type":"And","matchers":[{"type":"Item","name":"Syxwvsuwmyagdm66hdtho11ux4.Status","operator":"Equal","value":1,"matchers":[]}]}}`,
		},
		{
			expr: `Status >= 1 and Status < 5`,
			want: `{"matcher":{"type":"And","matchers":[
				{"type":"Item","name":"Syxwvsuwmyagdm66hdtho11ux4.Status","operator":"NotBelow","value":1,"matchers":[]},
				{"type":"Item","name":"Syxwvsuwmyagdm66hdtho11ux4.Status","operator":"Below","value":5,"matchers":[]}]}}`,
		},
		{
			expr: `F0000036 Like '国有'`,
			want: `{"matcher":{"type":"And","matchers":[{"type":"Item","name":"Syxwvsuwmyagdm66hdtho11ux4.F0000036","operator":"Contains","value":"国有","matchers":[]}]}}`,
		},
		{
			expr: `Name StartWith '瑞'`,
			want: `{"matcher":{"type":"And","matchers":[{"type":"Item","name":"Syxwvsuwmyagdm66hdtho11ux4.Name","operator":"StartWith","value":"瑞","matchers":[]}]}}`,
		},
		{
			expr: `Name NotEqual 'x'`,
			want: `{"matcher":{"type":"And","matchers":[{"type":"Item","name":"Syxwvsuwmyagdm66hdtho11ux4.Name","operator":"NotEqual","value":"x","matchers":[]}]}}`,
		},
		{
			expr: `Approved = true`,
			want: `{"matcher":{"type":"And","matchers":[{"type":"Item","name":"Syxwvsuwmyagdm66hdtho11ux4.Approved","operator":"Equal","value":true,"matchers":[]}]}}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.expr, func(t *testing.T) {
			assertPayload(t, mustPayload(t, schema, tt.expr), tt.want)
		})
	}
}

func TestBuildFilterGroupingAndOr(t *testing.T) {
	const schema = "Sch1"
	expr := `(Name Contains '测试' or Name EndWith '公司') and Status <> 2`
	want := `{"matcher":{"type":"And","matchers":[
		{"type":"Or","matchers":[
			{"type":"Item","name":"Sch1.Name","operator":"Contains","value":"测试","matchers":[]},
			{"type":"Item","name":"Sch1.Name","operator":"EndWith","value":"公司","matchers":[]}]},
		{"type":"Item","name":"Sch1.Status","operator":"NotEqual","value":2,"matchers":[]}]}}`
	assertPayload(t, mustPayload(t, schema, expr), want)
}

func TestBuildFilterListsAndRanges(t *testing.T) {
	const schema = "Sch2"
	tests := []struct {
		expr string
		want string
	}{
		{
			expr: `Status In (1, 2, 3)`,
			want: `{"matcher":{"type":"And","matchers":[{"type":"Item","name":"Sch2.Status","operator":"In","value":[1,2,3],"matchers":[]}]}}`,
		},
		{
			expr: `Name NotIn ('a','b')`,
			want: `{"matcher":{"type":"And","matchers":[{"type":"Item","name":"Sch2.Name","operator":"NotIn","value":["a","b"],"matchers":[]}]}}`,
		},
		{
			expr: `Name not in ('a')`,
			want: `{"matcher":{"type":"And","matchers":[{"type":"Item","name":"Sch2.Name","operator":"NotIn","value":["a"],"matchers":[]}]}}`,
		},
		{
			expr: `Amount Between 1.5 and 9.9`,
			want: `{"matcher":{"type":"And","matchers":[{"type":"Item","name":"Sch2.Amount","operator":"Between","value":[1.5,9.9],"matchers":[]}]}}`,
		},
		{
			expr: `CreatedTime Between '2026-09-01' and '2026-09-30'`,
			want: `{"matcher":{"type":"And","matchers":[{"type":"Item","name":"Sch2.CreatedTime","operator":"Between","value":["2026-09-01","2026-09-30"],"matchers":[]}]}}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.expr, func(t *testing.T) {
			assertPayload(t, mustPayload(t, schema, tt.expr), tt.want)
		})
	}
}

func TestBuildFilterNullChecks(t *testing.T) {
	const schema = "Sch3"
	tests := []struct {
		expr string
		want string
	}{
		{
			expr: `OwnerId IsNull`,
			want: `{"matcher":{"type":"And","matchers":[{"type":"Item","name":"Sch3.OwnerId","operator":"IsNull","matchers":[]}]}}`,
		},
		{
			expr: `OwnerId IsNotNull`,
			want: `{"matcher":{"type":"And","matchers":[{"type":"Item","name":"Sch3.OwnerId","operator":"NotNull","matchers":[]}]}}`,
		},
		{
			expr: `Remark IsNotNone`,
			want: `{"matcher":{"type":"And","matchers":[{"type":"Item","name":"Sch3.Remark","operator":"NotNone","matchers":[]}]}}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.expr, func(t *testing.T) {
			assertPayload(t, mustPayload(t, schema, tt.expr), tt.want)
		})
	}
}

func TestBuildFilterKeepsQualifiedFields(t *testing.T) {
	payload := mustPayload(t, "Sch4", `OtherSchema.Code Equal 'x'`)
	assertPayload(t, payload, `{"matcher":{"type":"And","matchers":[
		{"type":"Item","name":"OtherSchema.Code","operator":"Equal","value":"x","matchers":[]}]}}`)
}

func TestBuildFilterErrors(t *testing.T) {
	tests := []struct {
		schema string
		expr   string
		want   string // substring expected in the error
	}{
		{"", "Name = 1", "schema code is required"},
		{"Sch", "   ", "filter expression is empty"},
		{"Sch", "Name ? 1", "unknown operator"},
		{"Sch", "Name =", "expected a value"},
		{"Sch", "(Name = 1", "expected ')'"},
		{"Sch", "Name = 1 and", "expected a field name or '('"},
		{"Sch", "Name In (1,)", "expected a value"},
		{"Sch", "Name Is Something", "expected null or none after 'is'"},
		{"Sch", "Name Between 1", "expected 'and'"},
		{"Sch", "Name = 1 2", "unexpected"},
	}
	for _, tt := range tests {
		t.Run(tt.expr, func(t *testing.T) {
			_, err := BuildFilter(tt.schema, tt.expr)
			if err == nil {
				t.Fatalf("BuildFilter(%q) error = nil, want containing %q", tt.expr, tt.want)
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("BuildFilter(%q) error = %q, want containing %q", tt.expr, err, tt.want)
			}
		})
	}
}
