package httpapi

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"testing"
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
	case "sync-response-v1.json":
		return &syncResponseDTO{}
	case "error-epoch-mismatch.json":
		return &errorEnvelope{}
	default:
		return &map[string]any{}
	}
}
