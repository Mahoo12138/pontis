package library

import (
	"encoding/json"
	"fmt"

	"pontis/internal/canonical"
)

// journalParent is the wire representation of a ParentRef in journal
// payloads (same shape as the sync change stream).
type journalParent struct {
	Type string `json:"type"`
	ID   string `json:"id,omitempty"`
	Key  string `json:"key,omitempty"`
}

type createJournalPayload struct {
	Type     string        `json:"type"`
	Title    string        `json:"title"`
	URL      string        `json:"url,omitempty"`
	Parent   journalParent `json:"parent"`
	Position int64         `json:"position"`
}

type titleJournalPayload struct {
	Title string `json:"title"`
}

type urlJournalPayload struct {
	URL string `json:"url"`
}

type moveJournalPayload struct {
	Parent   journalParent `json:"parent"`
	Position int64         `json:"position"`
}

type deleteJournalPayload struct {
	Count int64 `json:"count"`
}

// summarize decodes the journal payload and renders a human-facing
// action and summary. V1 summaries are zh-CN, matching the web's
// current activity copy; the web i18n keys on Action for labels.
func summarize(row JournalRow) (action, summary string, err error) {
	switch canonical.ChangeType(row.Type) {
	case canonical.ChangeTypeCreate:
		var p createJournalPayload
		if err := json.Unmarshal([]byte(row.PayloadJSON), &p); err != nil {
			return "", "", fmt.Errorf("library: decode create payload: %w", err)
		}
		kind := "书签"
		if p.Type == string(canonical.NodeTypeFolder) {
			kind = "文件夹"
		}
		return "create", fmt.Sprintf("新建了「%s」%s", p.Title, kind), nil
	case canonical.ChangeTypeUpdateTitle:
		var p titleJournalPayload
		if err := json.Unmarshal([]byte(row.PayloadJSON), &p); err != nil {
			return "", "", fmt.Errorf("library: decode title payload: %w", err)
		}
		return "update", fmt.Sprintf("将标题修改为「%s」", p.Title), nil
	case canonical.ChangeTypeUpdateURL:
		var p urlJournalPayload
		if err := json.Unmarshal([]byte(row.PayloadJSON), &p); err != nil {
			return "", "", fmt.Errorf("library: decode url payload: %w", err)
		}
		return "update", "更新了链接地址", nil
	case canonical.ChangeTypeMove:
		var p moveJournalPayload
		if err := json.Unmarshal([]byte(row.PayloadJSON), &p); err != nil {
			return "", "", fmt.Errorf("library: decode move payload: %w", err)
		}
		return "move", "调整了位置或层级", nil
	case canonical.ChangeTypeDelete:
		var p deleteJournalPayload
		if err := json.Unmarshal([]byte(row.PayloadJSON), &p); err != nil {
			return "", "", fmt.Errorf("library: decode delete payload: %w", err)
		}
		return "delete", fmt.Sprintf("删除了 %d 个书签项", p.Count), nil
	default:
		return "update", "更新了书签", nil
	}
}
