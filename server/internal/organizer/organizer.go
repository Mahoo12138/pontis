// Package organizer implements detection-only tree hygiene: duplicate
// bookmark detection (exact + conservative normalization) and asynchronous
// link health checks. It never mutates the canonical tree (doc 12 §1):
// detect/propose, the user selects, the domain mutates.
package organizer

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"pontis/internal/canonical"
)

// TreeSource reads the canonical tree.
type TreeSource interface {
	Space(ctx context.Context, id canonical.SpaceID) (canonical.SyncSpace, error)
	ListNodes(ctx context.Context, space canonical.SpaceID) ([]canonical.Node, error)
}

// LinkOutcome is one check result.
type LinkOutcome struct {
	StatusClass string // ok_2xx | client_4xx | server_5xx | timeout | network_error
	HTTPStatus  int
	ErrorType   string
	LatencyMS   int64
	FinalURL    string
}

// LinkChecker performs one link check; implementations must respect ctx.
type LinkChecker func(ctx context.Context, rawURL string) LinkOutcome

// LinkResult is one checked bookmark.
type LinkResult struct {
	NodeID      string `json:"node_id"`
	Title       string `json:"title"`
	CheckedURL  string `json:"checked_url"`
	StatusClass string `json:"status_class"`
	HTTPStatus  int    `json:"http_status,omitempty"`
	ErrorType   string `json:"error_type,omitempty"`
	LatencyMS   int64  `json:"latency_ms"`
	FinalURL    string `json:"final_url,omitempty"`
	CheckedAt   string `json:"checked_at"`
}

// LinkRun is one (possibly in-progress) link check round.
type LinkRun struct {
	JobID      string       `json:"job_id"`
	Total      int          `json:"total"`
	Done       int          `json:"done"`
	FinishedAt string       `json:"finished_at,omitempty"`
	Results    []LinkResult `json:"results"`
}

// DuplicateGroup is one group of same-URL bookmarks.
type DuplicateGroup struct {
	ID     string           `json:"id"`
	Kind   string           `json:"kind"` // exact | suspected
	Reason string           `json:"reason,omitempty"`
	Items  []DuplicateItem  `json:"items"`
}

// DuplicateItem is one member of a duplicate group.
type DuplicateItem struct {
	NodeID string `json:"node_id"`
	Title  string `json:"title"`
	URL    string `json:"url"`
	Path   string `json:"path"`
}

// Service implements organizer features.
type Service struct {
	trees TreeSource

	mu   sync.Mutex
	runs map[canonical.SpaceID]*LinkRun
	// checker is injectable for tests; defaults to HTTP.
	checker LinkChecker
}

// NewService returns an organizer service using the real HTTP checker.
func NewService(trees TreeSource) *Service {
	return &Service{trees: trees, runs: map[canonical.SpaceID]*LinkRun{}, checker: httpChecker()}
}

// NewServiceWithChecker returns an organizer service with a custom checker.
func NewServiceWithChecker(trees TreeSource, checker LinkChecker) *Service {
	return &Service{trees: trees, runs: map[canonical.SpaceID]*LinkRun{}, checker: checker}
}

// checkConcurrency bounds the fan-out of one run.
const checkConcurrency = 8

// RunLinkCheck starts an asynchronous check of every bookmark in the
// space and returns the job id.
func (s *Service) RunLinkCheck(ctx context.Context, space canonical.SpaceID) (string, int, error) {
	nodes, err := s.trees.ListNodes(ctx, space)
	if err != nil {
		return "", 0, err
	}
	var bookmarks []canonical.Node
	for _, n := range nodes {
		if n.Type == canonical.NodeTypeBookmark && n.URL != "" {
			bookmarks = append(bookmarks, n)
		}
	}

	id, err := uuid.NewV7()
	if err != nil {
		return "", 0, err
	}
	run := &LinkRun{JobID: id.String(), Total: len(bookmarks)}
	s.mu.Lock()
	s.runs[space] = run
	s.mu.Unlock()

	go s.execute(run, bookmarks)
	return run.JobID, run.Total, nil
}

func (s *Service) execute(run *LinkRun, bookmarks []canonical.Node) {
	sem := make(chan struct{}, checkConcurrency)
	var wg sync.WaitGroup
	var mu sync.Mutex // protects run.Results ordering append
	now := time.Now().UTC().Format(time.RFC3339Nano)

	for _, b := range bookmarks {
		wg.Add(1)
		sem <- struct{}{}
		go func(n canonical.Node) {
			defer wg.Done()
			defer func() { <-sem }()
			// Individual checks get a hard budget independent of the
			// request that spawned the run.
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			defer cancel()
			out := s.checker(ctx, n.URL)
			mu.Lock()
			run.Results = append(run.Results, LinkResult{
				NodeID:      string(n.ID),
				Title:       n.Title,
				CheckedURL:  n.URL,
				StatusClass: out.StatusClass,
				HTTPStatus:  out.HTTPStatus,
				ErrorType:   out.ErrorType,
				LatencyMS:   out.LatencyMS,
				FinalURL:    out.FinalURL,
				CheckedAt:   now,
			})
			run.Done = len(run.Results)
			if run.Done >= run.Total {
				run.FinishedAt = now
			}
			mu.Unlock()
		}(b)
	}
	wg.Wait()
}

// LinkResults returns the latest run for the space, if any.
func (s *Service) LinkResults(ctx context.Context, space canonical.SpaceID) (LinkRun, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run, ok := s.runs[space]
	if !ok {
		return LinkRun{}, false
	}
	// Sorted copy: results arrive out of order.
	out := LinkRun{JobID: run.JobID, Total: run.Total, Done: run.Done, FinishedAt: run.FinishedAt}
	out.Results = append([]LinkResult(nil), run.Results...)
	sort.Slice(out.Results, func(i, j int) bool { return out.Results[i].NodeID < out.Results[j].NodeID })
	return out, true
}

// DuplicateItem path building needs parent titles; computed per request.
func (s *Service) Duplicates(ctx context.Context, space canonical.SpaceID) ([]DuplicateGroup, error) {
	nodes, err := s.trees.ListNodes(ctx, space)
	if err != nil {
		return nil, err
	}
	titles := map[canonical.NodeID]string{}
	parents := map[canonical.NodeID]canonical.NodeID{}
	for _, n := range nodes {
		titles[n.ID] = n.Title
		if n.Parent.Type == canonical.ParentTypeNode {
			parents[n.ID] = n.Parent.NodeID
		}
	}
	pathOf := func(id canonical.NodeID) string {
		parts := []string{}
		cur := id
		for {
			title, ok := titles[cur]
			if !ok {
				break
			}
			parts = append([]string{title}, parts...)
			next, ok := parents[cur]
			if !ok {
				break
			}
			cur = next
		}
		return strings.Join(parts, " / ")
	}

	var bookmarks []canonical.Node
	for _, n := range nodes {
		if n.Type == canonical.NodeTypeBookmark && n.URL != "" {
			bookmarks = append(bookmarks, n)
		}
	}

	item := func(n canonical.Node) DuplicateItem {
		return DuplicateItem{NodeID: string(n.ID), Title: n.Title, URL: n.URL, Path: pathOf(n.ID)}
	}

	// Exact duplicates: identical raw URL, placement irrelevant.
	byRaw := map[string][]canonical.Node{}
	for _, b := range bookmarks {
		byRaw[b.URL] = append(byRaw[b.URL], b)
	}
	exactURLs := map[string]bool{}
	var groups []DuplicateGroup
	for raw, list := range byRaw {
		if len(list) > 1 {
			exactURLs[raw] = true
			items := make([]DuplicateItem, 0, len(list))
			for _, n := range list {
				items = append(items, item(n))
			}
			groups = append(groups, DuplicateGroup{
				ID:    "exact-" + raw,
				Kind:  "exact",
				Items: items,
			})
		}
	}

	// Suspected duplicates: conservative normalization with reasons.
	type normEntry struct {
		items  []DuplicateItem
		raws   map[string]bool
		reason map[string]bool
	}
	byNorm := map[string]*normEntry{}
	for _, b := range bookmarks {
		key, reasons := normalizeURL(b.URL)
		e := byNorm[key]
		if e == nil {
			e = &normEntry{raws: map[string]bool{}, reason: map[string]bool{}}
			byNorm[key] = e
		}
		e.items = append(e.items, item(b))
		e.raws[b.URL] = true
		for _, r := range reasons {
			e.reason[r] = true
		}
	}
	for _, e := range byNorm {
		if len(e.items) < 2 {
			continue
		}
		// Exact groups are already reported; suspected = differing raws
		// that are not themselves an exact group.
		if len(e.raws) == 1 {
			continue
		}
		reasons := make([]string, 0, len(e.reason))
		for r := range e.reason {
			reasons = append(reasons, r)
		}
		sort.Strings(reasons)
		if len(reasons) == 0 {
			reasons = []string{"url_normalization"}
		}
		groups = append(groups, DuplicateGroup{
			ID:     "suspected-" + e.items[0].URL,
			Kind:   "suspected",
			Reason: strings.Join(reasons, ", "),
			Items:  e.items,
		})
	}
	sort.Slice(groups, func(i, j int) bool { return groups[i].ID < groups[j].ID })
	return groups, nil
}

// normalizeURL applies the conservative organizer normalization (doc 12
// §4): host case, default port, empty-path slash, common tracking params.
// It deliberately does NOT treat http==https or www as equal.
func normalizeURL(raw string) (key string, reasons []string) {
	u, err := url.Parse(raw)
	if err != nil {
		return raw, nil
	}
	var reasonSet []string

	tracking := []string{"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"}
	changed := false
	q := u.Query()
	for _, k := range tracking {
		if q.Get(k) != "" {
			q.Del(k)
			changed = true
		}
	}
	if changed {
		reasonSet = append(reasonSet, "tracking_params_only")
		u.RawQuery = q.Encode()
	}

	// Empty path vs "/" is the same page (doc 12 §4).
	if u.Path == "/" {
		u.Path = ""
		reasonSet = append(reasonSet, "trailing_slash_only")
	}
	if u.Path != "/" && strings.HasSuffix(u.Path, "/") {
		u.Path = strings.TrimRight(u.Path, "/")
		reasonSet = append(reasonSet, "trailing_slash_only")
	}
	if (u.Scheme == "https" && u.Port() == "443") || (u.Scheme == "http" && u.Port() == "80") {
		u.Host = u.Hostname()
		reasonSet = append(reasonSet, "default_port_only")
	}
	return u.String(), reasonSet
}

// httpChecker performs a bounded HEAD-first check with a GET fallback,
// classifying by final status (doc 12 §2).
func httpChecker() LinkChecker {
	client := &http.Client{
		Timeout: 8 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many redirects")
			}
			return nil
		},
	}
	return func(ctx context.Context, rawURL string) LinkOutcome {
		start := time.Now()
		outcome := func(statusClass string, status int, errType, finalURL string) LinkOutcome {
			return LinkOutcome{
				StatusClass: statusClass,
				HTTPStatus:  status,
				ErrorType:   errType,
				LatencyMS:   time.Since(start).Milliseconds(),
				FinalURL:    finalURL,
			}
		}
		try := func(method string) (int, string, error) {
			req, err := http.NewRequestWithContext(ctx, method, rawURL, nil)
			if err != nil {
				return 0, "invalid_url", err
			}
			resp, err := client.Do(req)
			if err != nil {
				return 0, "", err
			}
			defer resp.Body.Close()
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
			return resp.StatusCode, resp.Request.URL.String(), nil
		}
		status, final, err := try("HEAD")
		if err != nil || status == http.StatusMethodNotAllowed || status == http.StatusNotImplemented {
			// HEAD may be unsupported; fall back to a bounded GET.
			status, final, err = try("GET")
		}
		if err != nil {
			class, errType := "network_error", "request_failed"
			if strings.Contains(err.Error(), "timeout") || ctx.Err() == context.DeadlineExceeded {
				class, errType = "timeout", "timeout"
			}
			return outcome(class, 0, errType, "")
		}
		switch {
		case status >= 200 && status < 300:
			return outcome("ok_2xx", status, "", final)
		case status >= 300 && status < 400:
			// Client follows redirects; a lingering 3xx is odd but classify by code.
			return outcome("ok_2xx", status, "", final)
		case status >= 400 && status < 500:
			return outcome("client_4xx", status, "", final)
		default:
			return outcome("server_5xx", status, "", final)
		}
	}
}
