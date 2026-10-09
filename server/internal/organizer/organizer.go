// Package organizer implements detection-only tree hygiene: duplicate
// bookmark detection (exact + conservative normalization) and link health
// checks. A link check is a queue job like any other: its work and its
// results live in the database, so the organizer keeps no task system of its
// own. It never mutates the canonical tree (doc 12 §1): detect/propose, the
// user selects, the domain mutates.
package organizer

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"pontis/internal/canonical"
	"pontis/internal/jobs"
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
	ID     string          `json:"id"`
	Kind   string          `json:"kind"` // exact | suspected
	Reason string          `json:"reason,omitempty"`
	Items  []DuplicateItem `json:"items"`
}

// DuplicateItem is one member of a duplicate group.
type DuplicateItem struct {
	NodeID string `json:"node_id"`
	Title  string `json:"title"`
	URL    string `json:"url"`
	Path   string `json:"path"`
}

// LinkItem is one bookmark waiting to be checked.
type LinkItem struct {
	NodeID string
	Title  string
	URL    string
}

// RunStore is where a run's work and results live. It replaces the in-memory
// registry the organizer used to keep: the rows are the checkpoint, so a
// restarted worker resumes with the items that were never checked, and two
// runs of one space cannot see each other's results.
type RunStore interface {
	// SeedRun records the bookmark snapshot for one job. Idempotent: a
	// replay adds nothing and leaves already-checked items alone.
	SeedRun(ctx context.Context, jobID string, space canonical.SpaceID, items []LinkItem, at time.Time) error
	// PendingItems returns the items of one job that have no result yet.
	PendingItems(ctx context.Context, jobID string) ([]LinkItem, error)
	// CountItems reports the snapshot size and how much of it is done.
	CountItems(ctx context.Context, jobID string) (total int, checked int, err error)
	// RecordResult stores one outcome and marks the item checked.
	RecordResult(ctx context.Context, jobID, nodeID string, res LinkResult) error
	// FinishRun stamps the run's completion time.
	FinishRun(ctx context.Context, jobID string, at time.Time) error
	// LatestRun returns the newest run of a space, finished or not.
	LatestRun(ctx context.Context, space canonical.SpaceID) (LinkRun, bool, error)
}

// Queue is the job queue a run is submitted to. It is a parameter rather
// than service state because the queue and the organizer refer to each
// other: the queue runs the organizer's handler, and the organizer hands it
// the jobs. The organizer runs nothing of its own — enqueuing is the only
// way work begins.
type Queue interface {
	Enqueue(ctx context.Context, t jobs.Type, owner canonical.UserID, spaceID, payload string) (jobs.Job, error)
}

// Service implements organizer features.
type Service struct {
	trees TreeSource
	runs  RunStore
	// checker is injectable for tests; defaults to HTTP.
	checker LinkChecker
}

// NewService returns an organizer service using the real HTTP checker under
// the given outbound policy. The zero policy is the safe one: only
// publicly routable destinations are checked.
func NewService(trees TreeSource, runs RunStore, outbound Outbound) *Service {
	return &Service{trees: trees, runs: runs, checker: httpChecker(outbound)}
}

// NewServiceWithChecker returns an organizer service with a custom checker.
func NewServiceWithChecker(trees TreeSource, runs RunStore, checker LinkChecker) *Service {
	return &Service{trees: trees, runs: runs, checker: checker}
}

const (
	// checkConcurrency bounds the fan-out of one run.
	checkConcurrency = 8
	// checkTimeout is one item's request budget.
	checkTimeout = 8 * time.Second
)

// StartLinkCheck submits one link check and snapshots the space's bookmarks,
// so the caller learns how much work it just asked for. Nothing here is
// executed: the queue runs it.
func (s *Service) StartLinkCheck(ctx context.Context, queue Queue, user canonical.UserID, space canonical.SpaceID) (string, int, error) {
	job, err := queue.Enqueue(ctx, jobs.TypeLinkCheck, user, string(space), "")
	if err != nil {
		return "", 0, err
	}
	items, err := s.bookmarks(ctx, space)
	if err != nil {
		return "", 0, err
	}
	if err := s.runs.SeedRun(ctx, job.ID, space, items, time.Now().UTC()); err != nil {
		return "", 0, err
	}
	return job.ID, len(items), nil
}

// bookmarks snapshots the space's checkable URLs.
func (s *Service) bookmarks(ctx context.Context, space canonical.SpaceID) ([]LinkItem, error) {
	nodes, err := s.trees.ListNodes(ctx, space)
	if err != nil {
		return nil, err
	}
	var out []LinkItem
	for _, n := range nodes {
		if n.Type == canonical.NodeTypeBookmark && n.URL != "" {
			out = append(out, LinkItem{NodeID: string(n.ID), Title: n.Title, URL: n.URL})
		}
	}
	return out, nil
}

// CheckRun is the job handler for organizer.link_check. It visits the items
// this job has not checked yet, persisting each result as it lands. Every
// request it starts inherits the job's context, so a cancelled or reclaimed
// job stops the requests it made rather than finishing them unseen.
func (s *Service) CheckRun(ctx context.Context, job jobs.Job, report jobs.ReportFunc) error {
	if job.ID == "" || job.SpaceID == "" {
		return fmt.Errorf("%w: organizer: link check job needs an id and a space", jobs.FatalError)
	}
	space := canonical.SpaceID(job.SpaceID)
	// A schedule-triggered job arrives without a snapshot; take one now.
	items, err := s.bookmarks(ctx, space)
	if err != nil {
		return resumable(ctx, err)
	}
	if err := s.runs.SeedRun(ctx, job.ID, space, items, time.Now().UTC()); err != nil {
		return resumable(ctx, err)
	}
	pending, err := s.runs.PendingItems(ctx, job.ID)
	if err != nil {
		return resumable(ctx, err)
	}
	total, checked, err := s.runs.CountItems(ctx, job.ID)
	if err != nil {
		return resumable(ctx, err)
	}

	results := make(chan LinkResult, len(pending))
	var wg sync.WaitGroup
	sem := make(chan struct{}, checkConcurrency)
	for _, it := range pending {
		if ctx.Err() != nil {
			break
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(it LinkItem) {
			defer wg.Done()
			defer func() { <-sem }()
			checkCtx, cancel := context.WithTimeout(ctx, checkTimeout)
			defer cancel()
			out := s.checker(checkCtx, it.URL)
			if errors.Is(checkCtx.Err(), context.Canceled) {
				// The job was cancelled or reclaimed mid-flight. This item
				// has no answer, and storing an invented one would mark it
				// checked forever instead of resuming it.
				return
			}
			results <- LinkResult{
				NodeID:      it.NodeID,
				Title:       it.Title,
				CheckedURL:  it.URL,
				StatusClass: out.StatusClass,
				HTTPStatus:  out.HTTPStatus,
				ErrorType:   out.ErrorType,
				LatencyMS:   out.LatencyMS,
				FinalURL:    out.FinalURL,
				CheckedAt:   time.Now().UTC().Format(time.RFC3339Nano),
			}
		}(it)
	}
	go func() { wg.Wait(); close(results) }()

	// One writer: the goroutines above share no state with the run, so there
	// is no second lock for a reader to disagree with.
	done := checked
	for res := range results {
		// Write without the job's context: a cancellation must not throw away
		// what was already learned, the checkpoint is the point of persisting.
		if err := s.runs.RecordResult(context.WithoutCancel(ctx), job.ID, res.NodeID, res); err != nil {
			return err
		}
		done++
		if ctx.Err() == nil {
			cur, tot := int64(done), int64(total)
			if err := report("检查链接可达性", &cur, &tot); err != nil {
				return err
			}
		}
	}
	if err := ctx.Err(); err != nil {
		// An interrupted run is unfinished work, not a failed one: the items
		// already checked stay checked and the queue re-runs the same job for
		// the rest (doc 13 §5).
		return jobs.Retryable{Err: err}
	}
	return s.runs.FinishRun(ctx, job.ID, time.Now().UTC())
}

// resumable turns a failure caused by an interrupted job into a retry: the
// same job comes back for the items it did not reach, instead of failing with
// them still pending.
func resumable(ctx context.Context, err error) error {
	if err != nil && ctx.Err() != nil {
		return jobs.Retryable{Err: err}
	}
	return err
}

// LinkResults returns the latest run for the space, if any.
func (s *Service) LinkResults(ctx context.Context, space canonical.SpaceID) (LinkRun, bool, error) {
	return s.runs.LatestRun(ctx, space)
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
// classifying by final status (doc 12 §2). Every destination passes the
// outbound policy: the address is resolved and checked here and then dialed
// directly, and each redirect hop is validated again.
func httpChecker(ob Outbound) LinkChecker {
	const (
		maxRedirects  = 5
		maxResponseKB = 4 << 10
	)
	dialValidated := ob.Dial
	if dialValidated == nil {
		dialer := &net.Dialer{Timeout: checkTimeout}
		dialValidated = dialer.DialContext
	}
	client := &http.Client{
		Timeout: checkTimeout,
		// A proxy would fetch the real target somewhere this policy has no
		// say, so the transport always connects directly.
		Transport: &http.Transport{
			ForceAttemptHTTP2:     true,
			TLSHandshakeTimeout:   checkTimeout,
			ExpectContinueTimeout: time.Second,
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				host, port, err := net.SplitHostPort(addr)
				if err != nil {
					return nil, err
				}
				target, err := ob.validateTarget(ctx, host)
				if err != nil {
					return nil, err
				}
				// Dial the address that was just checked; the name is never
				// resolved a second time, so DNS cannot move underneath.
				return dialValidated(ctx, network, net.JoinHostPort(target, port))
			},
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= maxRedirects {
				return errors.New("too many redirects")
			}
			// A public front page that hops to an internal address is the
			// whole point of this check, so validate every leg.
			return validateTargetURL(req.URL)
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
		// Only http(s), no credentials in the url, no non-network scheme.
		if err := validateURL(rawURL); err != nil {
			return outcome("network_error", 0, "ssrf_blocked", "")
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
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxResponseKB))
			return resp.StatusCode, resp.Request.URL.String(), nil
		}
		status, final, err := try("HEAD")
		if !errors.Is(err, ErrBlocked) &&
			(err != nil || status == http.StatusMethodNotAllowed || status == http.StatusNotImplemented) {
			// HEAD may be unsupported; fall back to a bounded GET. A refused
			// destination is final, retrying it only asks twice.
			status, final, err = try("GET")
		}
		if err != nil {
			if errors.Is(err, ErrBlocked) {
				return outcome("network_error", 0, "ssrf_blocked", "")
			}
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
