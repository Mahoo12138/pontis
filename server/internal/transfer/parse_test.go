package transfer

import (
	"errors"
	"strings"
	"testing"
)

const netscapeSample = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="1700000001">Development</H3>
    <DL><p>
        <DT><A HREF="https://go.dev" ADD_DATE="1700000002">Go</A>
        <DT><A HREF="https://github.com" ICON="data:image/png;base64,xx">GitHub</A>
    </DL><p>
    <DT><A HREF="https://example.org">Example</A>
</DL><p>
`

func TestParseNetscapeHTMLTree(t *testing.T) {
	root, warnings, err := ParseImport(FormatNetscapeHTML, netscapeSample)
	if err != nil {
		t.Fatalf("ParseImport error: %v", err)
	}
	if root.Title != "imported" {
		t.Errorf("root title = %q, want imported", root.Title)
	}
	if len(root.Children) != 2 {
		t.Fatalf("root has %d children, want 2 (folder + bookmark)", len(root.Children))
	}
	dev := root.Children[0]
	if dev.URL != "" || dev.Title != "Development" || len(dev.Children) != 2 {
		t.Errorf("folder node wrong: %+v", dev)
	}
	if dev.Children[0].Title != "Go" || dev.Children[0].URL != "https://go.dev" {
		t.Errorf("first bookmark wrong: %+v", dev.Children[0])
	}
	if root.Children[1].Title != "Example" || root.Children[1].URL != "https://example.org" {
		t.Errorf("top-level bookmark wrong: %+v", root.Children[1])
	}
	if len(warnings) == 0 {
		t.Error("expected a warning about ignored ICON/ADD_DATE attributes")
	}
}

func TestParseNetscapeHTMLNoWarningForCleanFile(t *testing.T) {
	clean := "<DL><p>\n  <DT><A HREF=\"https://go.dev\">Go</A>\n</DL><p>\n"
	_, warnings, err := ParseImport(FormatNetscapeHTML, clean)
	if err != nil {
		t.Fatalf("ParseImport error: %v", err)
	}
	if len(warnings) != 0 {
		t.Errorf("warnings = %v, want none", warnings)
	}
}

func TestParseNetscapeHTMLMissingTitleFallsBackToURL(t *testing.T) {
	doc := "<DL><p>\n  <DT><A HREF=\"https://go.dev\"></A>\n</DL><p>\n"
	root, _, err := ParseImport(FormatNetscapeHTML, doc)
	if err != nil {
		t.Fatalf("ParseImport error: %v", err)
	}
	bm := root.Children[0]
	if bm.Title != "https://go.dev" {
		t.Errorf("title = %q, want fallback to href", bm.Title)
	}
}

func TestParseNetscapeHTMLEmptyDocument(t *testing.T) {
	if _, _, err := ParseImport(FormatNetscapeHTML, "<HTML></HTML>\n"); !errors.Is(err, ErrInvalidPayload) {
		t.Errorf("err = %v, want ErrInvalidPayload for a file without nodes", err)
	}
}

func TestParseNetscapeHTMLSingleQuotesHref(t *testing.T) {
	doc := "<DL><p>\n  <DT><A HREF='https://go.dev'>Go</A>\n</DL><p>\n"
	root, _, err := ParseImport(FormatNetscapeHTML, doc)
	if err != nil {
		t.Fatalf("ParseImport error: %v", err)
	}
	if root.Children[0].URL != "https://go.dev" {
		t.Errorf("single-quoted href not parsed: %+v", root.Children[0])
	}
}

func TestParseNetscapeHTMLTooDeep(t *testing.T) {
	var b strings.Builder
	b.WriteString("<DL><p>\n")
	for i := 0; i < 25; i++ {
		b.WriteString("<DT><H3>F</H3>\n<DL><p>\n")
	}
	for i := 0; i < 30; i++ {
		b.WriteString("</DL><p>\n")
	}
	if _, _, err := ParseImport(FormatNetscapeHTML, b.String()); !errors.Is(err, ErrTooDeep) {
		t.Errorf("err = %v, want ErrTooDeep", err)
	}
}

const jsonSample = `{
  "format": "pontis-portable-bookmarks",
  "version": 1,
  "root_slots": [{"key": "toolbar", "display_name": "Favorites bar", "position": 0}],
  "nodes": [
    {"id": "f1", "type": "folder", "title": "Dev", "parent_id": null, "position": 0},
    {"id": "b1", "type": "bookmark", "title": "Go", "url": "https://go.dev", "parent_id": "f1", "position": 0},
    {"id": "b2", "type": "bookmark", "title": "Spec", "url": "https://example.com", "root_key": "toolbar", "position": 1}
  ]
}`

func TestParsePortableJSONForest(t *testing.T) {
	root, warnings, err := ParseImport(FormatNativeJSON, jsonSample)
	if err != nil {
		t.Fatalf("ParseImport error: %v", err)
	}
	if len(root.Children) != 2 {
		t.Fatalf("root has %d children, want 2", len(root.Children))
	}
	folder := root.Children[0]
	if folder.Title != "Dev" || len(folder.Children) != 1 || folder.Children[0].URL != "https://go.dev" {
		t.Errorf("folder subtree wrong: %+v", folder)
	}
	if root.Children[1].Title != "Spec" {
		t.Errorf("root-level bookmark wrong: %+v", root.Children[1])
	}
	if len(warnings) == 0 {
		t.Error("expected an id-is-not-identity warning")
	}
}

func TestParsePortableJSONErrors(t *testing.T) {
	cases := []struct {
		name    string
		content string
		wantErr error
	}{
		{"not json", "{oops", ErrInvalidPayload},
		{"wrong format marker", `{"format":"other-export","nodes":[{"id":"b1","type":"bookmark","title":"x","url":"https://x"}]}`, ErrInvalidPayload},
		{"bookmark without url", `{"nodes":[{"id":"b1","type":"bookmark","title":"x"}]}`, ErrInvalidPayload},
		{"self parent", `{"nodes":[{"id":"f1","type":"folder","title":"F","parent_id":"f1"}]}`, ErrInvalidPayload},
		{"orphan node", `{"nodes":[{"id":"f1","type":"folder","title":"F"},{"id":"b1","type":"bookmark","title":"x","url":"https://x","parent_id":"missing"}]}`, ErrInvalidPayload},
		{"cycle", `{"nodes":[{"id":"f1","type":"folder","title":"F","parent_id":"f2"},{"id":"f2","type":"folder","title":"G","parent_id":"f1"}]}`, ErrInvalidPayload},
		{"too many nodes", jsonTooManyNodes(), ErrTooManyNodes},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, _, err := ParseImport(FormatNativeJSON, c.content); !errors.Is(err, c.wantErr) {
				t.Errorf("err = %v, want %v", err, c.wantErr)
			}
		})
	}
}

func jsonTooManyNodes() string {
	var b strings.Builder
	b.WriteString(`{"nodes":[{"id":"f1","type":"folder","title":"F"}`)
	for i := 0; i < MaxNodes+1; i++ {
		b.WriteString(`,{"id":"b` + itoa(i) + `","type":"bookmark","title":"x","url":"https://x","parent_id":"f1"}`)
	}
	b.WriteString("]}")
	return b.String()
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var digits []byte
	for i > 0 {
		digits = append([]byte{byte('0' + i%10)}, digits...)
		i /= 10
	}
	return string(digits)
}

func TestParsePortableJSONTooDeep(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"nodes":[{"id":"n0","type":"folder","title":"F0"}`)
	for i := 1; i <= 25; i++ {
		b.WriteString(`,{"id":"n` + itoa(i) + `","type":"folder","title":"F` + itoa(i) + `","parent_id":"n` + itoa(i-1) + `"}`)
	}
	b.WriteString("]}")
	if _, _, err := ParseImport(FormatNativeJSON, b.String()); !errors.Is(err, ErrTooDeep) {
		t.Errorf("err = %v, want ErrTooDeep", err)
	}
}

func TestParseImportUnknownFormat(t *testing.T) {
	if _, _, err := ParseImport("csv", "a,b,c"); !errors.Is(err, ErrInvalidFormat) {
		t.Errorf("err = %v, want ErrInvalidFormat", err)
	}
}

func TestParseImportContentTooLarge(t *testing.T) {
	huge := strings.Repeat("x", MaxContentLen+1)
	if _, _, err := ParseImport(FormatNativeJSON, huge); !errors.Is(err, ErrContentTooLarge) {
		t.Errorf("err = %v, want ErrContentTooLarge", err)
	}
}
