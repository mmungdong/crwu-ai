package h3yun

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode"
)

// This file compiles the `--filter` expression of `crwu h3yun records list`
// into the /v1/bizdata/query "filter" payload understood by the H3Yun web
// console. The payload is a matcher tree:
//
//	{ "filter": { "matcher": { "type": "And"|"Or", "matchers": [ ... ] } } }
//
// where each leaf is an Item matcher:
//
//	{ "type": "Item", "name": "<schemaCode>.<field>",
//	  "operator": "<ComparisonOperatorType member>", "value": ..., "matchers": [] }
//
// operator names are the C# enum ComparisonOperatorType members the API
// serializes ("Equal", "NotEqual", "Above", "NotBelow", "Below", "NotAbove",
// "Contains", "StartWith", "EndWith", "In", "NotIn", "IsNull", "NotNull",
// "IsNone", "NotNone", "Between"). The expression language is documented in
// docs/cli-manual.md (§5 记录筛选).

// ComparisonOperatorType member names accepted by /v1/bizdata/query.
const (
	matcherEqual        = "Equal"
	matcherNotEqual     = "NotEqual"
	matcherAbove        = "Above"
	matcherNotBelow     = "NotBelow"
	matcherBelow        = "Below"
	matcherNotAbove     = "NotAbove"
	matcherContains     = "Contains"
	matcherNotContains  = "NotContains"
	matcherStartWith    = "StartWith"
	matcherNotStartWith = "NotStartWith"
	matcherEndWith      = "EndWith"
	matcherNotEndWith   = "NotEndWith"
	matcherIsNull       = "IsNull"
	matcherNotNull      = "NotNull"
	matcherIsNone       = "IsNone"
	matcherNotNone      = "NotNone"
	matcherIn           = "In"
	matcherNotIn        = "NotIn"
	matcherBetween      = "Between"
)

// BuildFilter parses a WHERE-like filter expression for one form and returns
// the "filter" body value ready for QueryRecordsParams.Filter. Fields are
// automatically qualified as <schemaCode>.<field> unless they already contain
// a dot. An empty expression returns a non-nil error.
//
// Grammar (keywords case-insensitive):
//
//	expr        := orExpr
//	orExpr      := andExpr ( "or" andExpr )*
//	andExpr     := primary ( "and" primary )*
//	primary     := "(" orExpr ")" | predicate
//	predicate   := field op value | field "in" "(" value ("," value)* ")"
//	             | field "between" value "and" value | field isClause
//	op          := "=" | "!=" | "<>" | ">" | ">=" | "<" | "<="
//	             | eq | ne | gt | ge | lt | le | like | notlike
//	             | startwith/startswith | endwith/endswith
//	             | notstartwith/notstartswith | notendwith/notendswith
//	             | above | below | notabove | notbelow | equal | notequal
//	             | contains | notcontains | in | notin | "not" "in"
//	isClause    := "is" ["not"] ( "null" | "none" )
//
// String values must be quoted with ' or "; unquoted numbers and true/false
// become typed JSON values, any other bare token is treated as a string.
func BuildFilter(schemaCode, expr string) (map[string]any, error) {
	if strings.TrimSpace(schemaCode) == "" {
		return nil, errors.New("schema code is required to build a record filter")
	}
	trimmed := strings.TrimSpace(expr)
	if trimmed == "" {
		return nil, errors.New("filter expression is empty")
	}
	p := &filterParser{schemaCode: schemaCode, tokens: lexFilter(trimmed)}
	node, err := p.parseOr()
	if err != nil {
		return nil, err
	}
	if tk := p.peek(); tk.kind != tokenEOF {
		return nil, fmt.Errorf("filter: unexpected %q at %d", tk.text, tk.pos)
	}
	if node["type"] == "Item" {
		// A bare predicate at the root is wrapped in an And collection, the
		// same shape the web console uses for every filtered query.
		node = filterAnd(node)
	}
	return map[string]any{"matcher": node}, nil
}

// --- lexer ---------------------------------------------------------------

type tokenKind int

const (
	tokenEOF tokenKind = iota
	tokenWord
	tokenString
	tokenOp // one of = != <> > >= < <=
	tokenLParen
	tokenRParen
	tokenComma
)

type filterToken struct {
	kind tokenKind
	text string
	pos  int // byte offset in the source expression
}

func lexFilter(src string) []filterToken {
	var tokens []filterToken
	for i := 0; i < len(src); {
		c := src[i]
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			i++
			continue
		}
		start := i
		switch {
		case c == '(':
			tokens = append(tokens, filterToken{kind: tokenLParen, text: "(", pos: start})
			i++
		case c == ')':
			tokens = append(tokens, filterToken{kind: tokenRParen, text: ")", pos: start})
			i++
		case c == ',':
			tokens = append(tokens, filterToken{kind: tokenComma, text: ",", pos: start})
			i++
		case c == '\'' || c == '"':
			i++
			var b strings.Builder
			for i < len(src) && src[i] != c {
				if src[i] == '\\' && i+1 < len(src) {
					i++
					switch src[i] {
					case 'n':
						b.WriteByte('\n')
					case 't':
						b.WriteByte('\t')
					case 'r':
						b.WriteByte('\r')
					default:
						b.WriteByte(src[i])
					}
					i++
					continue
				}
				b.WriteByte(src[i])
				i++
			}
			if i >= len(src) {
				tokens = append(tokens, filterToken{kind: tokenString, text: b.String(), pos: start})
				break
			}
			i++ // closing quote
			tokens = append(tokens, filterToken{kind: tokenString, text: b.String(), pos: start})
		case c == '=' || c == '!' || c == '<' || c == '>':
			two := ""
			if i+1 < len(src) {
				switch {
				case c == '<' && (src[i+1] == '=' || src[i+1] == '>'):
					two = src[i : i+2] // <= <>
				case c == '>' && src[i+1] == '=':
					two = src[i : i+2] // >=
				case c == '!' && src[i+1] == '=':
					two = src[i : i+2] // !=
				}
			}
			if two != "" {
				tokens = append(tokens, filterToken{kind: tokenOp, text: two, pos: start})
				i += 2
				break
			}
			tokens = append(tokens, filterToken{kind: tokenOp, text: string(c), pos: start})
			i++
		default:
			for i < len(src) {
				r := rune(src[i])
				if src[i] == '(' || src[i] == ')' || src[i] == ',' ||
					src[i] == '=' || src[i] == '!' || src[i] == '<' || src[i] == '>' ||
					src[i] == '\'' || src[i] == '"' || unicode.IsSpace(r) {
					break
				}
				i++
			}
			tokens = append(tokens, filterToken{kind: tokenWord, text: src[start:i], pos: start})
		}
	}
	return tokens
}

// --- parser --------------------------------------------------------------

type filterParser struct {
	schemaCode string
	tokens     []filterToken
	index      int
}

func (p *filterParser) peek() filterToken {
	if p.index >= len(p.tokens) {
		return filterToken{kind: tokenEOF}
	}
	return p.tokens[p.index]
}

func (p *filterParser) peekAt(offset int) filterToken {
	if p.index+offset >= len(p.tokens) {
		return filterToken{kind: tokenEOF}
	}
	return p.tokens[p.index+offset]
}

func (p *filterParser) next() filterToken {
	tk := p.peek()
	if tk.kind != tokenEOF {
		p.index++
	}
	return tk
}

func (p *filterParser) fail(tk filterToken, format string, args ...any) error {
	msg := fmt.Sprintf(format, args...)
	return fmt.Errorf("filter: %s at %d", msg, tk.pos)
}

// parseOr parses orExpr.
func (p *filterParser) parseOr() (map[string]any, error) {
	left, err := p.parseAnd()
	if err != nil {
		return nil, err
	}
	var children []any
	if left["type"] == "Or" {
		children = left["matchers"].([]any)
	} else {
		children = []any{left}
	}
	for p.isKeyword(p.peek(), "or") {
		p.next()
		right, err := p.parseAnd()
		if err != nil {
			return nil, err
		}
		if right["type"] == "Or" {
			children = append(children, right["matchers"].([]any)...)
		} else {
			children = append(children, right)
		}
	}
	if len(children) == 1 {
		return children[0].(map[string]any), nil
	}
	return map[string]any{"type": "Or", "matchers": children}, nil
}

// parseAnd parses andExpr.
func (p *filterParser) parseAnd() (map[string]any, error) {
	left, err := p.parsePrimary()
	if err != nil {
		return nil, err
	}
	var children []any
	if left["type"] == "And" {
		children = left["matchers"].([]any)
	} else {
		children = []any{left}
	}
	for p.isKeyword(p.peek(), "and") {
		p.next()
		right, err := p.parsePrimary()
		if err != nil {
			return nil, err
		}
		if right["type"] == "And" {
			children = append(children, right["matchers"].([]any)...)
		} else {
			children = append(children, right)
		}
	}
	if len(children) == 1 {
		return children[0].(map[string]any), nil
	}
	return map[string]any{"type": "And", "matchers": children}, nil
}

func (p *filterParser) parsePrimary() (map[string]any, error) {
	tk := p.peek()
	switch tk.kind {
	case tokenLParen:
		p.next()
		node, err := p.parseOr()
		if err != nil {
			return nil, err
		}
		if close := p.next(); close.kind != tokenRParen {
			return nil, p.fail(close, "expected ')' to close the group opened at %d", tk.pos)
		}
		return node, nil
	case tokenWord:
		return p.parsePredicate()
	default:
		return nil, p.fail(tk, "expected a field name or '('")
	}
}

// parsePredicate parses "field <operator> ..." and returns an Item matcher.
func (p *filterParser) parsePredicate() (map[string]any, error) {
	field := p.next()
	name := field.text
	if !strings.Contains(name, ".") {
		name = p.schemaCode + "." + name
	}
	op, unary, err := p.parseOperator()
	if err != nil {
		return nil, err
	}
	item := map[string]any{
		"type":     "Item",
		"name":     name,
		"operator": op,
		"matchers": []any{},
	}
	switch {
	case op == matcherIn || op == matcherNotIn:
		values, err := p.parseValueList()
		if err != nil {
			return nil, err
		}
		item["value"] = values
	case op == matcherBetween:
		low, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		if !p.isKeyword(p.peek(), "and") {
			return nil, p.fail(p.peek(), "expected 'and' between the two between values")
		}
		p.next()
		high, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		item["value"] = []any{low, high}
	case !unary:
		value, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		item["value"] = value
	}
	return item, nil
}

// parseOperator reads the operator phrase after a field and returns the
// ComparisonOperatorType name, whether the operator is unary (takes no value)
// and any error.
func (p *filterParser) parseOperator() (op string, unary bool, err error) {
	tk := p.next()
	if tk.kind == tokenOp {
		switch tk.text {
		case "=":
			return matcherEqual, false, nil
		case "!=", "<>":
			return matcherNotEqual, false, nil
		case ">":
			return matcherAbove, false, nil
		case ">=":
			return matcherNotBelow, false, nil
		case "<":
			return matcherBelow, false, nil
		case "<=":
			return matcherNotAbove, false, nil
		}
		return "", false, p.fail(tk, "unsupported operator %q", tk.text)
	}
	if tk.kind != tokenWord {
		return "", false, p.fail(tk, "expected an operator after the field name")
	}
	word := strings.ToLower(tk.text)
	switch word {
	case "is":
		not := p.tryKeyword("not")
		what := p.next()
		if what.kind != tokenWord {
			return "", false, p.fail(what, "expected null or none after 'is'")
		}
		switch strings.ToLower(what.text) {
		case "null":
			if not {
				return matcherNotNull, true, nil
			}
			return matcherIsNull, true, nil
		case "none":
			if not {
				return matcherNotNone, true, nil
			}
			return matcherIsNone, true, nil
		}
		return "", false, p.fail(what, "expected null or none after 'is', got %q", what.text)
	case "not":
		second := p.peek()
		if second.kind != tokenWord {
			return "", false, p.fail(second, "expected an operator after 'not'")
		}
		switch strings.ToLower(second.text) {
		case "in":
			p.next()
			return matcherNotIn, false, nil
		case "like", "contains":
			p.next()
			return matcherNotContains, false, nil
		case "startswith", "startwith":
			p.next()
			return matcherNotStartWith, false, nil
		case "endswith", "endwith":
			p.next()
			return matcherNotEndWith, false, nil
		case "null":
			p.next()
			return matcherNotNull, true, nil
		case "none":
			p.next()
			return matcherNotNone, true, nil
		}
		return "", false, p.fail(second, "unsupported operator after 'not': %q", second.text)
	case "between":
		return matcherBetween, false, nil
	case "in":
		return matcherIn, false, nil
	case "notin":
		return matcherNotIn, false, nil
	case "isnull":
		return matcherIsNull, true, nil
	case "notnull", "isnotnull":
		return matcherNotNull, true, nil
	case "isnone":
		return matcherIsNone, true, nil
	case "notnone", "isnotnone":
		return matcherNotNone, true, nil
	}
	scalar := map[string]string{
		"eq": matcherEqual, "equal": matcherEqual,
		"ne": matcherNotEqual, "neq": matcherNotEqual, "notequal": matcherNotEqual,
		"gt": matcherAbove, "above": matcherAbove,
		"ge": matcherNotBelow, "gte": matcherNotBelow, "notbelow": matcherNotBelow,
		"lt": matcherBelow, "below": matcherBelow,
		"le": matcherNotAbove, "lte": matcherNotAbove, "notabove": matcherNotAbove,
		"like": matcherContains, "contains": matcherContains,
		"notlike": matcherNotContains, "notcontains": matcherNotContains,
		"startwith": matcherStartWith, "startswith": matcherStartWith,
		"notstartwith": matcherNotStartWith, "notstartswith": matcherNotStartWith,
		"endwith": matcherEndWith, "endswith": matcherEndWith,
		"notendwith": matcherNotEndWith, "notendswith": matcherNotEndWith,
	}
	if mapped, ok := scalar[word]; ok {
		return mapped, false, nil
	}
	return "", false, p.fail(tk, "unknown operator %q", tk.text)
}

func (p *filterParser) parseValueList() ([]any, error) {
	open := p.next()
	if open.kind != tokenLParen {
		return nil, p.fail(open, "expected '(' after the in/notin operator")
	}
	var values []any
	for {
		v, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		values = append(values, v)
		switch p.peek().kind {
		case tokenComma:
			p.next()
		case tokenRParen:
			p.next()
			if len(values) == 0 {
				return nil, p.fail(open, "the in/notin value list is empty")
			}
			return values, nil
		default:
			return nil, p.fail(p.peek(), "expected ',' or ')' inside the value list")
		}
	}
}

// parseValue parses one scalar value: quoted string, number, true/false, or a
// bare token used as a string.
func (p *filterParser) parseValue() (any, error) {
	tk := p.next()
	switch tk.kind {
	case tokenString:
		return tk.text, nil
	case tokenWord:
		switch strings.ToLower(tk.text) {
		case "true":
			return true, nil
		case "false":
			return false, nil
		}
		if number, ok := parseNumber(tk.text); ok {
			return number, nil
		}
		return tk.text, nil
	default:
		return nil, p.fail(tk, "expected a value, got %q", tk.text)
	}
}

func (p *filterParser) tryKeyword(word string) bool {
	if p.isKeyword(p.peek(), word) {
		p.next()
		return true
	}
	return false
}

func (p *filterParser) isKeyword(tk filterToken, word string) bool {
	return tk.kind == tokenWord && strings.EqualFold(tk.text, word)
}

func parseNumber(text string) (any, bool) {
	if _, err := strconv.ParseFloat(text, 64); err != nil {
		return nil, false
	}
	if integer, err := strconv.ParseInt(text, 10, 64); err == nil {
		return integer, true
	}
	value, _ := strconv.ParseFloat(text, 64)
	return value, true
}

func filterAnd(items ...map[string]any) map[string]any {
	children := make([]any, 0, len(items))
	for _, item := range items {
		children = append(children, item)
	}
	return map[string]any{"type": "And", "matchers": children}
}
