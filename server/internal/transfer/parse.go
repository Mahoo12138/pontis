// Package transfer implements import/export (doc 11): side-effect-free
// exports in Netscape HTML or portable JSON, and the Parse → Validate →
// Plan pipeline for imports. Import applies go through the canonical
// executor; external IDs are never treated as canonical identity.
package transfer

import (
	"encoding/json"
	"errors"
	"strings"
)

// Format is the transfer wire format.
type Format string

const (
	FormatNetscapeHTML Format = "netscape_html"
	FormatNativeJSON   Format = "native_json"
)

// Parser safety bounds (doc 11 §10).
const (
	MaxContentLen = 10 << 20 // 10 MiB
	MaxNodes      = 10000
	MaxDepth      = 20
	MaxTitleLen   = 255
	MaxURLLen     = 2048
)

// Errors.
var (
	ErrInvalidFormat   = errors.New("transfer: unknown format")
	ErrContentTooLarge = errors.New("transfer: content exceeds size limit")
	ErrTooManyNodes    = errors.New("transfer: too many nodes")
	ErrTooDeep         = errors.New("transfer: tree exceeds depth limit")
	ErrInvalidPayload  = errors.New("transfer: content is not a valid import file")
)

// ImportNode is one parsed node of an import tree.
type ImportNode struct {
	Title    string
	URL      string
	Children []ImportNode
}

// portableFile is the native JSON wire format. Node ids inside the file
// are file-local and only express parent relations.
type portableFile struct {
	Format    string          `json:"format"`
	Version   int             `json:"version"`
	RootSlots []portableSlot  `json:"root_slots"`
	Nodes     []portableNode  `json:"nodes"`
}

type portableSlot struct {
	Key         string `json:"key"`
	DisplayName string `json:"display_name"`
	Position    int64  `json:"position"`
}

type portableNode struct {
	ID       string  `json:"id"`
	Type     string  `json:"type"`
	Title    string  `json:"title"`
	URL      *string `json:"url"`
	ParentID *string `json:"parent_id"`
	RootKey  *string `json:"root_key"`
	Position int64   `json:"position"`
}

// ParseImport validates and parses an import file into a tree. The second
// return carries human-readable warnings (ignored attributes and the like).
func ParseImport(format Format, content string) (*ImportNode, []string, error) {
	if len(content) > MaxContentLen {
		return nil, nil, ErrContentTooLarge
	}
	switch format {
	case FormatNetscapeHTML:
		return parseNetscapeHTML(content)
	case FormatNativeJSON:
		return parsePortableJSON(content)
	default:
		return nil, nil, ErrInvalidFormat
	}
}

// --- Netscape HTML ---

// htmlNode uses pointer children so the parse stack stays stable while
// siblings are appended.
type htmlNode struct {
	title    string
	url      string
	children []*htmlNode
}

// parseNetscapeHTML reads the small subset browsers actually write:
// folder hierarchy via H3+DL nesting and bookmarks via A[HREF]. ADD_DATE,
// ICON, tags and separators are tolerated and ignored.
func parseNetscapeHTML(content string) (*ImportNode, []string, error) {
	warnings := []string{}
	root := &htmlNode{title: "imported"}
	stack := []*htmlNode{root}
	depth := 1
	nodes := 0

	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		upper := strings.ToUpper(line)
		switch {
		case strings.Contains(upper, "<DL"):
			depth++
			if depth > MaxDepth {
				return nil, nil, ErrTooDeep
			}
		case strings.Contains(upper, "</DL"):
			if len(stack) > 1 {
				stack = stack[:len(stack)-1]
			}
			depth--
		case strings.Contains(upper, "<DT"):
			parent := stack[len(stack)-1]
			if title, ok := extractTag(line, "h3"); ok {
				if nodes >= MaxNodes {
					return nil, nil, ErrTooManyNodes
				}
				nodes++
				if len(title) > MaxTitleLen {
					title = title[:MaxTitleLen]
				}
				folder := &htmlNode{title: title}
				parent.children = append(parent.children, folder)
				stack = append(stack, folder)
			} else if href, ok := extractHRef(line); ok {
				if nodes >= MaxNodes {
					return nil, nil, ErrTooManyNodes
				}
				nodes++
				title, _ := extractTag(line, "a")
				if title == "" {
					title = href
				}
				if len(title) > MaxTitleLen {
					title = title[:MaxTitleLen]
				}
				if len(href) > MaxURLLen {
					href = href[:MaxURLLen]
				}
				if strings.Contains(upper, "ICON=") || strings.Contains(upper, "ADD_DATE=") {
					if len(warnings) < 5 && !containsString(warnings, "部分条目包含将被忽略的属性(ICON / ADD_DATE)。") {
						warnings = append(warnings, "部分条目包含将被忽略的属性(ICON / ADD_DATE)。")
					}
				}
				parent.children = append(parent.children, &htmlNode{title: title, url: href})
			}
		}
	}
	if nodes == 0 {
		return nil, nil, ErrInvalidPayload
	}
	return convertHTML(root), warnings, nil
}

func containsString(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func convertHTML(n *htmlNode) *ImportNode {
	out := &ImportNode{Title: n.title, URL: n.url}
	for _, c := range n.children {
		out.Children = append(out.Children, *convertHTML(c))
	}
	return out
}

// extractTag pulls the inner text of <tag ...>inner</tag> (case-insensitive).
func extractTag(line, tag string) (string, bool) {
	open := "<" + tag
	lower := strings.ToLower(line)
	i := strings.Index(lower, open)
	if i < 0 {
		return "", false
	}
	rest := line[i:]
	gt := strings.Index(rest, ">")
	if gt < 0 {
		return "", false
	}
	rest = rest[gt+1:]
	close := "</" + tag + ">"
	j := strings.Index(strings.ToLower(rest), close)
	if j < 0 {
		// Tolerate unclosed tags by taking the rest of the line.
		return strings.TrimSpace(rest), rest != ""
	}
	return strings.TrimSpace(rest[:j]), true
}

// extractHRef pulls the HREF attribute of an <A> tag.
func extractHRef(line string) (string, bool) {
	lower := strings.ToLower(line)
	i := strings.Index(lower, "href=\"")
	if i < 0 {
		i = strings.Index(lower, "href='")
		if i < 0 {
			return "", false
		}
		rest := line[i+len("href='"):]
		j := strings.Index(rest, "'")
		if j < 0 {
			return "", false
		}
		return strings.TrimSpace(rest[:j]), true
	}
	rest := line[i+len(`href="`):]
	j := strings.Index(rest, "\"")
	if j < 0 {
		return "", false
	}
	return strings.TrimSpace(rest[:j]), true
}

// --- Native JSON ---

func parsePortableJSON(content string) (*ImportNode, []string, error) {
	var file portableFile
	if err := json.Unmarshal([]byte(content), &file); err != nil {
		return nil, nil, ErrInvalidPayload
	}
	if file.Format != "" && file.Format != "pontis-portable-bookmarks" {
		return nil, nil, ErrInvalidPayload
	}
	if len(file.Nodes) > MaxNodes {
		return nil, nil, ErrTooManyNodes
	}

	byID := make(map[string]*ImportNode, len(file.Nodes))
	for _, n := range file.Nodes {
		title := n.Title
		if len(title) > MaxTitleLen {
			title = title[:MaxTitleLen]
		}
		node := &ImportNode{Title: title}
		if n.URL != nil {
			if len(*n.URL) > MaxURLLen {
				return nil, nil, ErrInvalidPayload
			}
			node.URL = *n.URL
		}
		if node.URL == "" && n.Type != "folder" {
			return nil, nil, ErrInvalidPayload
		}
		byID[n.ID] = node
	}
	// Wire children by parent id, then verify the graph is a forest:
	// every node reachable from exactly one root, no cycles, no orphans.
	childrenOf := map[string][]string{}
	rootIDs := []string{}
	for _, n := range file.Nodes {
		if n.ParentID != nil {
			if *n.ParentID == n.ID {
				return nil, nil, ErrInvalidPayload
			}
			childrenOf[*n.ParentID] = append(childrenOf[*n.ParentID], n.ID)
		} else {
			rootIDs = append(rootIDs, n.ID)
		}
	}
	visited := map[string]bool{}
	var visit func(id string, depth int) bool
	visit = func(id string, depth int) bool {
		if depth > MaxDepth {
			return false
		}
		if visited[id] {
			return true
		}
		visited[id] = true
		for _, c := range childrenOf[id] {
			if !visit(c, depth+1) {
				return false
			}
		}
		return true
	}
	for _, r := range rootIDs {
		if !visit(r, 1) {
			return nil, nil, ErrTooDeep
		}
	}
	if len(visited) != len(file.Nodes) {
		return nil, nil, ErrInvalidPayload
	}

	var build func(id string, depth int) *ImportNode
	build = func(id string, depth int) *ImportNode {
		n := byID[id]
		out := &ImportNode{Title: n.Title, URL: n.URL}
		for _, c := range childrenOf[id] {
			out.Children = append(out.Children, *build(c, depth+1))
		}
		return out
	}

	root := &ImportNode{Title: "imported"}
	for _, r := range rootIDs {
		root.Children = append(root.Children, *build(r, 1))
	}
	warnings := []string{"文件中的 ID 仅用于表达层级,不会作为系统标识。"}
	return root, warnings, nil
}
