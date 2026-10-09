package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// postRaw sends a sync request and returns the response body untouched.
// Decoding into a map would erase the difference between `[]` and `null`,
// which is exactly the contract these tests pin down.
func postRawSync(t *testing.T, url, deviceToken, bindingID string, body map[string]any) []byte {
	t.Helper()
	buf, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, url+"/api/v1/sync/bindings/"+bindingID, bytes.NewReader(buf))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+deviceToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("sync status = %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func emptySyncRequest() map[string]any {
	return map[string]any{
		"protocol_version":  1,
		"epoch":             int64(1),
		"applied_revision":  int64(0),
		"received_revision": int64(0),
		"operations":        []any{},
		"max_changes":       500,
	}
}

// A remote-only pull sends no operations. The response arrays must stay
// arrays: the client iterates both, so `null` breaks the receive
// transaction and stalls the binding.
func TestSyncResponseArraysAreNeverNull(t *testing.T) {
	st := bootstrapFlow(t)

	raw := postRawSync(t, st.ts.URL, st.deviceToken, st.bindingID, emptySyncRequest())
	body := string(raw)
	if strings.Contains(body, "null") {
		t.Fatalf("sync response contains null where an array is required: %s", body)
	}
	for _, field := range []string{`"operation_results":[]`, `"changes":[]`} {
		if !strings.Contains(body, field) {
			t.Fatalf("response missing %s:\n%s", field, body)
		}
	}

	// The same request shape with an operation must keep both arrays typed.
	withOp := emptySyncRequest()
	withOp["operations"] = []any{map[string]any{
		"op_id":         "op-contract-1",
		"client_seq":    int64(1),
		"base_revision": int64(0),
		"type":          "create",
		"node_id":       "22222222-2222-7222-8222-222222222222",
		"node_type":     "folder",
		"title":         "Work",
		"parent":        map[string]any{"type": "root", "key": "main"},
	}}
	raw = postRawSync(t, st.ts.URL, st.deviceToken, st.bindingID, withOp)
	body = string(raw)
	t.Logf("with operation: %s", body)
	var decoded struct {
		OperationResults json.RawMessage `json:"operation_results"`
		Changes          json.RawMessage `json:"changes"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if string(decoded.OperationResults) == "null" || string(decoded.Changes) == "null" {
		t.Fatalf("protocol array serialized as null: %s", body)
	}
}

// Round-trip the Go handler's bytes through the same shape the extension
// consumes, so a nil slice cannot reach a for-of loop undetected.
func TestSyncResponseDecodesIntoClientShapedArrays(t *testing.T) {
	st := bootstrapFlow(t)
	raw := postRawSync(t, st.ts.URL, st.deviceToken, st.bindingID, emptySyncRequest())

	var resp struct {
		OperationResults []struct {
			OpID string `json:"op_id"`
		} `json:"operation_results"`
		Changes []struct {
			Revision int64 `json:"revision"`
		} `json:"changes"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		t.Fatalf("response is not consumable as arrays: %v (%s)", err, raw)
	}
	// Unmarshalling `null` leaves a nil slice; unmarshalling `[]` gives a
	// non-nil empty slice. The consumer iterates both, so require the latter.
	if resp.OperationResults == nil {
		t.Fatalf("operation_results decoded as nil, consumers would iterate a null value")
	}
	if resp.Changes == nil {
		t.Fatalf("changes decoded as nil, consumers would iterate a null value")
	}
}
