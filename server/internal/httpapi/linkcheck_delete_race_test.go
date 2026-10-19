package httpapi

import (
	"context"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"pontis/internal/canonical"
	"pontis/internal/jobs"
	"pontis/internal/library"
	"pontis/internal/store/sqlite"
)

// deletionBarrier holds the first node write before it opens its real SQLite
// transaction. The organizer has already verified the whole batch at this
// point, while a second HTTP request can still change that tree. Later writes
// pass through, so this reproduces the actual check/delete race without a
// production hook or a fake canonical transaction.
type deletionBarrier struct {
	library.Writer
	entered chan struct{}
	release chan struct{}
	used    atomic.Bool
}

func (b *deletionBarrier) BeginTx(ctx context.Context) (canonical.Tx, error) {
	if b.used.CompareAndSwap(false, true) {
		close(b.entered)
		select {
		case <-b.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return b.Writer.BeginTx(ctx)
}

func holdFirstNodeWrite(t *testing.T, f *libraryFlow) (*deletionBarrier, func()) {
	t.Helper()
	b := &deletionBarrier{
		Writer: sqlite.NewStore(f.db), entered: make(chan struct{}), release: make(chan struct{}),
	}
	f.srv.Library = library.NewService(sqlite.NewLibraryStore(f.db), b, f.srv.Changesets)
	var once sync.Once
	release := func() { once.Do(func() { close(b.release) }) }
	t.Cleanup(release)
	return b, release
}

// startHeldLinkDeletion returns a function that releases the transaction and
// waits for the real HTTP response, after the caller performs competing work.
func startHeldLinkDeletion(t *testing.T, f *libraryFlow, h map[string]string, jobID string, ids []string) func() map[string]any {
	t.Helper()
	barrier, release := holdFirstNodeWrite(t, f)
	type response struct {
		code int
		body map[string]any
	}
	finished := make(chan response, 1)
	go func() {
		code, out := deleteBroken(t, f, h, jobID, ids)
		finished <- response{code, out}
	}()
	select {
	case <-barrier.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("cleanup never reached the delete transaction")
	}
	return func() map[string]any {
		t.Helper()
		release()
		select {
		case resp := <-finished:
			if resp.code != http.StatusOK {
				t.Fatalf("cleanup = %d %v", resp.code, resp.body)
			}
			return resp.body
		case <-time.After(5 * time.Second):
			t.Fatal("cleanup did not finish after the competing mutation")
			return nil
		}
	}
}

func TestLinkCheckDeleteProtectsChangesAfterVerification(t *testing.T) {
	const scannedURL = "https://broken.example/404"
	const repairedURL = "https://fixed.example/ok"
	for _, tc := range []struct {
		name    string
		reason  string
		wantURL string
		mutate  func(*testing.T, *libraryFlow, map[string]string, string)
	}{
		{
			name: "web repair", reason: "url_changed", wantURL: repairedURL,
			mutate: func(t *testing.T, f *libraryFlow, h map[string]string, id string) {
				mustCall(t, "PATCH", f.ts.URL+"/api/v1/spaces/"+f.spaceID+"/nodes/"+id, h,
					map[string]string{"url": repairedURL})
			},
		},
		{
			name: "sync repair", reason: "url_changed", wantURL: repairedURL,
			mutate: func(t *testing.T, f *libraryFlow, h map[string]string, id string) {
				sp, err := f.srv.Library.Space(t.Context(), canonical.SpaceID(f.spaceID))
				if err != nil {
					t.Fatal(err)
				}
				req := emptySyncRequest()
				req["applied_revision"], req["received_revision"] = sp.CurrentRevision, sp.CurrentRevision
				req["operations"] = []map[string]any{{
					"op_id": "repair-during-cleanup", "client_seq": 1, "base_revision": sp.CurrentRevision,
					"type": "update_url", "node_id": id, "url": repairedURL,
				}}
				body := mustCall(t, "POST", f.ts.URL+"/api/v1/sync/bindings/"+f.bindingID, bearer(f.deviceToken), req)
				result := body["operation_results"].([]any)[0].(map[string]any)
				if result["status"] != "APPLIED" {
					t.Fatalf("sync repair = %v, want APPLIED", result)
				}
			},
		},
		{
			name: "url changed and changed back", reason: "url_changed", wantURL: scannedURL,
			mutate: func(t *testing.T, f *libraryFlow, h map[string]string, id string) {
				for _, url := range []string{repairedURL, scannedURL} {
					mustCall(t, "PATCH", f.ts.URL+"/api/v1/spaces/"+f.spaceID+"/nodes/"+id, h,
						map[string]string{"url": url})
				}
			},
		},
		{
			name: "already deleted", reason: "node_gone",
			mutate: func(t *testing.T, f *libraryFlow, h map[string]string, id string) {
				mustCall(t, "DELETE", f.ts.URL+"/api/v1/spaces/"+f.spaceID+"/nodes/"+id, h, nil)
			},
		},
		{
			name: "restore keeps the uuid and url", reason: "node_changed", wantURL: scannedURL,
			mutate: func(t *testing.T, f *libraryFlow, h map[string]string, id string) {
				root := f.ts.URL + "/api/v1/spaces/" + f.spaceID
				backup := mustCall(t, "POST", root+"/backups", h, nil)
				mustCall(t, "POST", root+"/backups/"+backup["id"].(string)+"/restore", h, nil)
			},
		},
		{
			name: "delete and undo recreate the uuid", reason: "node_changed", wantURL: scannedURL,
			mutate: func(t *testing.T, f *libraryFlow, h map[string]string, id string) {
				root := f.ts.URL + "/api/v1/spaces/" + f.spaceID
				mustCall(t, "DELETE", root+"/nodes/"+id, h, nil)
				activity := mustCall(t, "GET", root+"/activity", h, nil)
				entry := activity["activity"].([]any)[0].(map[string]any)
				mustCall(t, "POST", root+"/changesets/"+entry["id"].(string)+"/undo", h, nil)
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := bootstrapLibraryFlow(t)
			h := bearer(f.sessionToken)
			seedBookmarks(t, f, h, scannedURL)
			useChecker(t, f, classifyChecker())
			jobID, _ := enqueueLinkCheck(t, f, h)
			startQueue(t, f.srv)
			body := waitForDone(t, f, h, 1)
			waitForJobStatus(t, f.srv, jobID, jobs.StatusSucceeded)
			id := body["results"].([]any)[0].(map[string]any)["node_id"].(string)

			finish := startHeldLinkDeletion(t, f, h, jobID, []string{id})
			tc.mutate(t, f, h, id)
			before, err := f.srv.Library.Space(t.Context(), canonical.SpaceID(f.spaceID))
			if err != nil {
				t.Fatal(err)
			}
			body = finish()
			if deleted := deletedOf(t, body); len(deleted) != 0 {
				t.Errorf("cleanup deleted %v after the bookmark changed", deleted)
			}
			if reason := reasonsOf(t, body)[id]; reason[0] != tc.reason {
				t.Errorf("skip = %v, want %s", reason, tc.reason)
			} else if tc.reason == "url_changed" && reason[1] != tc.wantURL {
				t.Errorf("current URL detail = %q, want %q", reason[1], tc.wantURL)
			}
			left := spaceNodeMap(t, f, h, f.spaceID)
			if tc.wantURL == "" {
				if _, exists := left[id]; exists {
					t.Error("cleanup resurrected the concurrently deleted node")
				}
			} else if n, exists := left[id]; !exists || n["url"] != tc.wantURL {
				t.Errorf("concurrent work was lost: node = %v, want URL %s", n, tc.wantURL)
			}
			after, err := f.srv.Library.Space(t.Context(), canonical.SpaceID(f.spaceID))
			if err != nil {
				t.Fatal(err)
			}
			if after.CurrentRevision != before.CurrentRevision {
				t.Errorf("refused cleanup created revisions: %d -> %d", before.CurrentRevision, after.CurrentRevision)
			}
		})
	}
}

// A mixed batch must still delete the unchanged finding, report each refusal,
// and record normal undo history. The fixture is the actual HTTP response;
// @pontis/api consumes the same bytes through its runtime contract checker.
func TestGoldenLinkDeletionMixedResult(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	h := bearer(f.sessionToken)
	root := f.ts.URL + "/api/v1/spaces/" + f.spaceID
	const kept, repaired, gone, recreated = "https://keep.example/404", "https://repair.example/404", "https://gone.example/404", "https://recreated.example/404"
	seedBookmarks(t, f, h, kept, repaired, gone, recreated)
	useChecker(t, f, classifyChecker())
	jobID, _ := enqueueLinkCheck(t, f, h)
	startQueue(t, f.srv)
	run := waitForDone(t, f, h, 4)
	waitForJobStatus(t, f.srv, jobID, jobs.StatusSucceeded)
	byURL := map[string]string{}
	for _, r := range run["results"].([]any) {
		finding := r.(map[string]any)
		byURL[finding["checked_url"].(string)] = finding["node_id"].(string)
	}
	added := mustCall(t, "POST", root+"/nodes", h, map[string]any{
		"type": "bookmark", "title": "Not scanned", "url": "https://new.example",
		"parent": map[string]string{"type": "root", "key": "main"},
	})["id"].(string)
	finish := startHeldLinkDeletion(t, f, h, jobID, []string{byURL[kept], byURL[repaired], byURL[gone], byURL[recreated], added})

	// These mutations happen after verification. A title/move keeps the same
	// link evidence, while the successful delete must capture their new values
	// for undo instead of restoring the values from the original scan.
	const title = "Renamed while cleanup waited"
	mustCall(t, "PATCH", root+"/nodes/"+byURL[kept], h, map[string]string{"title": title})
	folder := mustCall(t, "POST", root+"/nodes", h, map[string]any{
		"type": "folder", "title": "Moved here", "parent": map[string]string{"type": "root", "key": "main"},
	})["id"].(string)
	mustCall(t, "PATCH", root+"/nodes/"+byURL[kept]+"/move", h,
		map[string]any{"parent": map[string]string{"type": "node", "id": folder}})
	mustCall(t, "PATCH", root+"/nodes/"+byURL[repaired], h, map[string]string{"url": "https://repair.example/fixed"})
	mustCall(t, "DELETE", root+"/nodes/"+byURL[recreated], h, nil)
	entry := activityEntries(t, f.ts.URL, f.spaceID, f.sessionToken)[0]
	mustCall(t, "POST", root+"/changesets/"+entry["id"].(string)+"/undo", h, nil)
	mustCall(t, "DELETE", root+"/nodes/"+byURL[gone], h, nil)

	body := finish()
	if deleted := deletedOf(t, body); !equalStrings(deleted, []string{byURL[kept]}) {
		t.Fatalf("deleted = %v, want only the unchanged finding", deleted)
	}
	reasons := reasonsOf(t, body)
	for id, want := range map[string]string{
		byURL[repaired]: "url_changed", byURL[gone]: "node_gone", byURL[recreated]: "node_changed", added: "not_in_run",
	} {
		if got := reasons[id][0]; got != want {
			t.Errorf("skip %s = %s, want %s", id, got, want)
		}
	}
	left := spaceNodeMap(t, f, h, f.spaceID)
	if _, exists := left[byURL[kept]]; exists {
		t.Fatal("successful cleanup left its bookmark in the tree")
	}
	if left[byURL[repaired]]["url"] != "https://repair.example/fixed" || left[byURL[recreated]]["url"] != recreated || left[added]["url"] != "https://new.example" {
		t.Fatalf("mixed cleanup lost a skipped bookmark: %v", left)
	}

	entry = activityEntries(t, f.ts.URL, f.spaceID, f.sessionToken)[0]
	if entry["action"] != "delete" || entry["undoable"] != true {
		t.Fatalf("cleanup did not record an undoable delete: %v", entry)
	}
	mustCall(t, "POST", root+"/changesets/"+entry["id"].(string)+"/undo", h, nil)
	restored := spaceNodeMap(t, f, h, f.spaceID)[byURL[kept]]
	if restored["title"] != title || restored["parent_id"] != folder {
		t.Fatalf("undo lost the pre-delete title or parent: %v", restored)
	}
	assertRESTFixture(t, "link-deletion-mixed", body)
}
