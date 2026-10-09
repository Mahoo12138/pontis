package httpapi

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"pontis/internal/reconcile"
)

// Golden protocol fixtures (doc 21 §9): the Go wire DTOs are the source
// of truth; the TypeScript extension validates its codec against the
// same files to prevent wire schema drift.
var updateFixtures = flag.Bool("update-fixtures", false, "rewrite the golden protocol fixtures")

const fixtureDir = "../../../fixtures/protocol"

type fixtureFile struct {
	name    string
	payload any
}

func goldenFixtures() []fixtureFile {
	nodeParent := &parentDTO{Type: "node", ID: "0198c0de-7000-7000-8000-0000000000bb"}
	rootParent := &parentDTO{Type: "root", Key: "main"}

	create := operationDTO{
		OpID:         "0198c0de-7000-7000-8000-000000000001",
		ClientSeq:    42,
		Type:         "create",
		BaseRevision: 100,
		NodeID:       "0198c0de-7000-7000-8000-0000000000aa",
		NodeType:     "bookmark",
		Title:        "GitHub",
		URL:          "https://github.com",
		Parent:       nodeParent,
	}
	before := "0198c0de-7000-7000-8000-0000000000cc"
	move := operationDTO{
		OpID:         "0198c0de-7000-7000-8000-000000000002",
		ClientSeq:    43,
		Type:         "move",
		BaseRevision: 100,
		NodeID:       "0198c0de-7000-7000-8000-0000000000aa",
		Parent:       rootParent,
		BeforeID:     &before,
	}

	return []fixtureFile{
		{"operation-create-v1.json", create},
		{"operation-move-v1.json", move},
		{"sync-request-v1.json", syncRequestDTO{
			ProtocolVersion:  1,
			Epoch:            1,
			AppliedRevision:  100,
			ReceivedRevision: 120,
			Operations:       []operationDTO{create, move},
			MaxChanges:       500,
		}},
		{"sync-response-v1.json", syncResponseDTO{
			ProtocolVersion:      1,
			Epoch:                1,
			JournalFloorRevision: 0,
			FromRevision:         121,
			ThroughRevision:      122,
			ServerRevision:       130,
			HasMore:              false,
			OperationResults: []operationResultDTO{{
				OpID:                create.OpID,
				ClientSeq:           create.ClientSeq,
				Status:              "APPLIED",
				Reason:              "",
				ResultRevision:      121,
				SettleAfterRevision: 121,
			}},
			Changes: []changeDTO{
				{
					Revision: 121,
					Type:     "create",
					NodeID:   "0198c0de-7000-7000-8000-0000000000aa",
					Payload:  json.RawMessage(`{"type":"bookmark","title":"GitHub","url":"https://github.com","parent":{"type":"node","id":"0198c0de-7000-7000-8000-0000000000bb"},"position":3}`),
				},
				{
					Revision: 122,
					Type:     "move",
					NodeID:   "0198c0de-7000-7000-8000-0000000000aa",
					Payload:  json.RawMessage(`{"parent":{"type":"root","key":"main"},"position":0}`),
				},
			},
		}},
		{"error-epoch-mismatch.json", errorEnvelope{Error: errorBody{
			Code:      "EPOCH_MISMATCH",
			Message:   "canonical epoch changed",
			RequestID: "req_fixture",
		}}},
		// A remote-only pull sends no operations. Both protocol arrays must
		// still encode as [] — a null would break every consumer that
		// iterates them.
		{"sync-response-empty-v1.json", syncResponseDTO{
			ProtocolVersion:      1,
			Epoch:                1,
			JournalFloorRevision: 0,
			FromRevision:         120,
			ThroughRevision:      120,
			ServerRevision:       120,
			HasMore:              false,
			OperationResults:     []operationResultDTO{},
			Changes:              []changeDTO{},
		}},

		// --- reconciliation lifecycle (doc 08 §9-§13) ---
		// The first synchronization: a pending binding's browser tree is the
		// only side that has data, so the client snapshot declares local refs
		// and no canonical ids (doc 08 §10).
		{"reconcile-client-snapshot-v1.json", reconcile.ClientSnapshotJSON{
			Epoch: 1, Revision: 44,
			Roots: []reconcile.ClientRootJSON{
				{LocalRef: "l_1", RootKey: "main", Title: "Bookmarks Bar"},
			},
			Nodes: []reconcile.ClientNodeJSON{
				{LocalRef: "l_2", ParentLocalRef: "l_1", Type: "folder", Title: "Reading", URL: ""},
				{LocalRef: "l_3", ParentLocalRef: "l_2", Type: "bookmark",
					Title: "Example", URL: "https://example.com"},
			},
		}},
		// The frozen canonical target and one page of its rows. The cursor is
		// an offset into this snapshot's own order, and the last page reports
		// an empty one.
		{"reconcile-server-snapshot-v1.json", serverSnapshotDTO{
			SnapshotID: "0198c0de-7000-7000-8000-000000000100",
			BindingID:  "0198c0de-7000-7000-8000-000000000010",
			SpaceID:    "0198c0de-7000-7000-8000-000000000020",
			Epoch:      1, Revision: 120, NodeCount: 4,
			Checksum:  "6b1c02d7f0a5e8e21b0f4a9d6c3b2a1908f7e6d5c4b3a291807f6e5d4c3b2a19",
			ExpiresAt: "2026-01-02T00:00:00Z",
			CreatedAt: "2026-01-01T00:00:00Z",
		}},
		{"reconcile-snapshot-nodes-v1.json", snapshotNodesPageDTO{
			Nodes: []serverSnapshotNodeDTO{
				{NodeRef: "r_main", Type: "root", Title: "Bookmarks Bar", RootKey: "main", Position: 0},
				{NodeRef: "0198c0de-7000-7000-8000-0000000000aa", ParentRef: "r_main",
					Type: "folder", Title: "Reading", Position: 0},
			},
			Total:      4,
			NextCursor: "2",
		}},
		// A planned session: the issue set is always an array, the plan carries
		// the base the commit re-checks.
		{"reconcile-session-planned-v1.json", sessionEnvelopeDTO{
			Session: sessionDTO{
				ID:        "0198c0de-7000-7000-8000-000000000200",
				BindingID: "0198c0de-7000-7000-8000-000000000010",
				SpaceID:   "0198c0de-7000-7000-8000-000000000020",
				Type:      "initial", Reason: "first synchronization",
				State: "waiting_user", Phase: "planned",
				SourceEpoch: 1, SourceRevision: 44, TargetEpoch: 1, TargetRevision: 120,
				PlanHash:  "6f7e8d9c0b1a2f3e4d5c6b7a8990a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2",
				CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-01T00:02:00Z",
			},
			Issues: []issueDTO{{
				ID: "0198c0de-7000-7000-8000-000000000201", Type: "ambiguous_identity",
				Payload: reconcile.IssuePayloadJSON{
					SourceRef: "l_3", Type: "bookmark", Title: "Example",
					URL: "https://example.com",
					Candidates: []string{
						"0198c0de-7000-7000-8000-0000000000aa",
						"0198c0de-7000-7000-8000-0000000000ab",
					},
				},
				// An empty default is the safe one: create a duplicate rather
				// than guess an identity (doc 06 §6).
				DefaultChoice: "",
			}},
			Plan: &reconcile.PlanArtifactJSON{
				Type: "initial", Strategy: "merge", Placement: "contents",
				BaseEpoch: 1, BaseRevision: 120,
				PlanHash: "6f7e8d9c0b1a2f3e4d5c6b7a8990a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2",
				Operations: []reconcile.PrimitiveJSON{{
					Kind: "create", NodeID: "0198c0de-7000-7000-8000-0000000000ac",
					Type: "bookmark", Title: "Example", URL: "https://example.com",
					Parent: &reconcile.ParentJSON{Type: "node",
						ID: "0198c0de-7000-7000-8000-0000000000aa"},
					SourceRef: "l_3",
				}},
				Stats:    reconcile.StatsJSON{Creates: 1},
				Warnings: []string{},
			},
		}},
		// The apply steps the client runs against the browser: identity first,
		// then creates, and never a delete of a node the server kept.
		{"reconcile-steps-v1.json", reconcile.StepsArtifactJSON{
			PlanHash: "6f7e8d9c0b1a2f3e4d5c6b7a8990a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2",
			Steps: []reconcile.StepJSON{
				{Kind: "assign_identity", LocalRef: "l_2", CanonicalID: "0198c0de-7000-7000-8000-0000000000aa"},
				{Kind: "create", CanonicalID: "0198c0de-7000-7000-8000-0000000000ac", Type: "bookmark",
					Title: "Example", URL: "https://example.com",
					Parent: &reconcile.ParentJSON{Type: "node",
						ID: "0198c0de-7000-7000-8000-0000000000aa"}},
			},
		}},
		// Complete hands back the binding the device syncs from now on.
		{"reconcile-session-completed-v1.json", sessionEnvelopeDTO{
			Session: sessionDTO{
				ID:        "0198c0de-7000-7000-8000-000000000200",
				BindingID: "0198c0de-7000-7000-8000-000000000010",
				SpaceID:   "0198c0de-7000-7000-8000-000000000020",
				Type:      "initial", Reason: "first synchronization",
				State: "completed", Phase: "committed",
				SourceEpoch: 1, SourceRevision: 44, TargetEpoch: 1, TargetRevision: 120,
				PlanHash:        "6f7e8d9c0b1a2f3e4d5c6b7a8990a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2",
				ServerCommitted: true, CommitRevision: 121,
				CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-01T00:05:00Z",
				CompletedAt: "2026-01-01T00:05:00Z",
			},
			Issues: []issueDTO{},
			Binding: &bindingResponse{
				ID:       "0198c0de-7000-7000-8000-000000000010",
				DeviceID: "0198c0de-7000-7000-8000-000000000030",
				SpaceID:  "0198c0de-7000-7000-8000-000000000020",
				State:    "active", Epoch: 1,
				AppliedRevision: 121, ReceivedRevision: 121, MaxClientSeq: 0,
			},
		}},
	}
}

func TestGoldenProtocolFixtures(t *testing.T) {
	for _, f := range goldenFixtures() {
		t.Run(f.name, func(t *testing.T) {
			path := filepath.Join(fixtureDir, f.name)
			b, err := json.MarshalIndent(f.payload, "", "  ")
			if err != nil {
				t.Fatal(err)
			}
			b = append(b, '\n')

			if *updateFixtures {
				if err := os.MkdirAll(fixtureDir, 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, b, 0o644); err != nil {
					t.Fatal(err)
				}
				return
			}

			want, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("read golden file (run go test -run TestGoldenProtocolFixtures -update-fixtures): %v", err)
			}
			if string(want) != string(b) {
				t.Fatalf("fixture drifted from the Go wire DTOs:\n got %s\nwant %s", b, want)
			}

			// Round-trip: the golden file must decode back into the DTO
			// and re-encode to the same data, ignoring indentation.
			dst := freshDTO(f.name)
			if err := json.Unmarshal(want, dst); err != nil {
				t.Fatalf("decode golden file: %v", err)
			}
			again, err := json.Marshal(dst)
			if err != nil {
				t.Fatal(err)
			}
			var a, c any
			_ = json.Unmarshal(b, &a)
			_ = json.Unmarshal(again, &c)
			if fmt.Sprint(a) != fmt.Sprint(c) {
				t.Fatalf("round-trip changed the encoding:\n got %s\nwant %s", again, b)
			}
		})
	}
}

// freshDTO returns an empty decode target matching the fixture kind.
func freshDTO(name string) any {
	switch name {
	case "operation-create-v1.json", "operation-move-v1.json":
		return &operationDTO{}
	case "sync-request-v1.json":
		return &syncRequestDTO{}
	case "sync-response-v1.json", "sync-response-empty-v1.json":
		return &syncResponseDTO{}
	case "error-epoch-mismatch.json":
		return &errorEnvelope{}
	case "reconcile-client-snapshot-v1.json":
		return &reconcile.ClientSnapshotJSON{}
	case "reconcile-server-snapshot-v1.json":
		return &serverSnapshotDTO{}
	case "reconcile-snapshot-nodes-v1.json":
		return &snapshotNodesPageDTO{}
	case "reconcile-session-planned-v1.json", "reconcile-session-completed-v1.json":
		return &sessionEnvelopeDTO{}
	case "reconcile-steps-v1.json":
		return &reconcile.StepsArtifactJSON{}
	default:
		return &map[string]any{}
	}
}
