package httpapi

import (
	"net/http"
	"testing"
)

// The web dialog answers "为什么删不掉" from this body, so the kinds still
// holding the space have to travel in the response. A code that only maps to
// one generic sentence tells a reader whose space holds no bookmark that it
// holds a bookmark.
func TestDeleteSpaceRefusalNamesItsBlockers(t *testing.T) {
	_, ts := newTestServer(t)
	token := restBootstrap(t, ts)

	spaceID := restPOST(t, ts, token, "/api/v1/spaces", map[string]string{"name": "要删的空间"})["id"].(string)
	restPOST(t, ts, token, "/api/v1/spaces/"+spaceID+"/nodes", map[string]any{
		"type": "bookmark", "title": "example", "url": "https://example.com",
		"parent": map[string]string{"type": "root", "key": "main"},
	})

	out := restExpect(t, ts, token, http.StatusConflict, http.MethodDelete, "/api/v1/spaces/"+spaceID, nil)
	body, _ := out["error"].(map[string]any)
	if body == nil {
		t.Fatalf("no error envelope: %v", out)
	}
	if body["code"] != "SPACE_NOT_EMPTY" {
		t.Fatalf("code = %v, want SPACE_NOT_EMPTY", body["code"])
	}
	details, _ := body["details"].(map[string]any)
	if details == nil {
		t.Fatalf("no details on a refusal the client has to phrase: %v", body)
	}
	blockers, _ := details["blockers"].([]any)
	if len(blockers) != 1 || blockers[0] != "content" {
		t.Fatalf("blockers = %v, want exactly [content]", details["blockers"])
	}

	// The same request after the content is gone answers 204, so the list is a
	// description of what is left rather than a permanent refusal.
	nodes := restGET(t, ts, token, "/api/v1/spaces/"+spaceID+"/nodes")
	rows, _ := nodes["nodes"].([]any)
	if len(rows) != 1 {
		t.Fatalf("fixture space should hold one node, got %v", nodes["nodes"])
	}
	nodeID := rows[0].(map[string]any)["id"].(string)
	restExpect(t, ts, token, http.StatusNoContent, http.MethodDelete,
		"/api/v1/spaces/"+spaceID+"/nodes/"+nodeID, nil)
	restExpect(t, ts, token, http.StatusNoContent, http.MethodDelete, "/api/v1/spaces/"+spaceID, nil)
}
