package httpapi

import (
	"net/http"
	"testing"
)

// registerDeviceFor creates a device for the session's owner via the API.
func registerDeviceFor(t *testing.T, tsURL, token, name string) (deviceID, secret string) {
	t.Helper()
	code, body := doJSON(t, "POST", tsURL+"/api/v1/devices",
		map[string]string{"Authorization": "Bearer " + token},
		map[string]string{"name": name, "browser": "edge", "platform": "windows"})
	if code != http.StatusCreated {
		t.Fatalf("register device = %d %v", code, body)
	}
	dev := body["device"].(map[string]any)
	return dev["id"].(string), body["token"].(string)
}

func TestDeviceOverviewAndRevoke(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	h := map[string]string{"Authorization": "Bearer " + f.sessionToken}

	deviceID, deviceSecret := registerDeviceFor(t, f.ts.URL, f.sessionToken, "Edge on Windows")

	// Overview lists the device without bindings.
	code, body := doJSON(t, "GET", f.ts.URL+"/api/v1/devices/overview", h, nil)
	if code != http.StatusOK {
		t.Fatalf("overview = %d %v", code, body)
	}
	devices := body["devices"].([]any)
	if len(devices) != 2 { // bootstrap already registered one device
		t.Fatalf("expected 2 devices, got %d", len(devices))
	}
	var dev map[string]any
	for _, d := range devices {
		if d.(map[string]any)["id"] == deviceID {
			dev = d.(map[string]any)
		}
	}
	if dev == nil || dev["name"] != "Edge on Windows" {
		t.Fatalf("new device missing from overview: %v", devices)
	}

	// Bind the device to alice's space via the device credential.
	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/device/bindings",
		map[string]string{"Authorization": "Bearer " + deviceSecret},
		map[string]string{"space_id": f.spaceID})
	if code != http.StatusCreated {
		t.Fatalf("bind = %d %v", code, body)
	}

	// Overview now shows the binding as pending/warning (never synced).
	code, body = doJSON(t, "GET", f.ts.URL+"/api/v1/devices/overview", h, nil)
	if code != http.StatusOK {
		t.Fatalf("overview 2 = %d %v", code, body)
	}
	var bindings []any
	for _, d := range body["devices"].([]any) {
		if d.(map[string]any)["id"] == deviceID {
			bindings = d.(map[string]any)["bindings"].([]any)
		}
	}
	if len(bindings) != 1 {
		t.Fatalf("expected 1 binding, got %v", bindings)
	}
	b := bindings[0].(map[string]any)
	if b["space_name"] != "Alice's Space" && b["space_name"] == "" {
		t.Fatalf("binding missing space name: %v", b)
	}
	if b["health"] != "warning" {
		t.Fatalf("pending binding health = %v, want warning", b["health"])
	}

	// Bob cannot revoke alice's device; alice can.
	code, _ = doJSON(t, "DELETE", f.ts.URL+"/api/v1/devices/"+deviceID,
		map[string]string{"Authorization": "Bearer " + f.bobToken}, nil)
	if code != http.StatusNotFound {
		t.Fatalf("bob revoke = %d, want 404", code)
	}
	code = doEmpty(t, "DELETE", f.ts.URL+"/api/v1/devices/"+deviceID, h)
	if code != http.StatusNoContent {
		t.Fatalf("revoke = %d", code)
	}
	code, body = doJSON(t, "GET", f.ts.URL+"/api/v1/devices/overview", h, nil)
	if code != http.StatusOK {
		t.Fatalf("post-revoke overview = %d %v", code, body)
	}
	// Only the bootstrap device remains.
	if got := len(body["devices"].([]any)); got != 1 {
		t.Fatalf("post-revoke device count = %d, want 1", got)
	}

	// The revoked device credential no longer authenticates.
	code, body = doJSON(t, "GET", f.ts.URL+"/api/v1/device/bindings",
		map[string]string{"Authorization": "Bearer " + deviceSecret}, nil)
	if code != http.StatusUnauthorized {
		t.Fatalf("revoked device credential = %d %v", code, body)
	}
}

func TestProfileAndPassword(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	h := map[string]string{"Authorization": "Bearer " + f.sessionToken}

	// Profile update.
	code, body := doJSON(t, "PATCH", f.ts.URL+"/api/v1/auth/me", h,
		map[string]any{"display_name": "Alice Chen", "email": "alice@example.com"})
	if code != http.StatusOK || body["display_name"] != "Alice Chen" {
		t.Fatalf("profile = %d %v", code, body)
	}
	code, body = doJSON(t, "GET", f.ts.URL+"/api/v1/auth/me", h, nil)
	if code != http.StatusOK || body["email"] != "alice@example.com" {
		t.Fatalf("me after update = %d %v", code, body)
	}

	// Wrong current password is rejected.
	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/auth/password", h,
		map[string]string{"current_password": "wrong-pass", "new_password": "newpassword1"})
	if code != http.StatusForbidden {
		t.Fatalf("wrong current password = %d %v", code, body)
	}

	// Password change succeeds and invalidates OTHER sessions.
	_, otherLogin := doJSON(t, "POST", f.ts.URL+"/api/v1/auth/login", nil,
		map[string]string{"username": "alice", "password": "password123"})
	otherToken := otherLogin["token"].(string)

	code, body = doJSON(t, "POST", f.ts.URL+"/api/v1/auth/password", h,
		map[string]string{"current_password": "password123", "new_password": "newpassword1"})
	if code != http.StatusOK {
		t.Fatalf("password change = %d %v", code, body)
	}

	code, _ = doJSON(t, "GET", f.ts.URL+"/api/v1/auth/me",
		map[string]string{"Authorization": "Bearer " + otherToken}, nil)
	if code != http.StatusUnauthorized {
		t.Fatalf("other session still valid: %d", code)
	}
	code, _ = doJSON(t, "GET", f.ts.URL+"/api/v1/auth/me", h, nil)
	if code != http.StatusOK {
		t.Fatalf("current session invalidated: %d", code)
	}
}

func TestSystemSettingsAdminOnly(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	adminHeader := map[string]string{"Authorization": "Bearer " + f.sessionToken}
	bobHeader := map[string]string{"Authorization": "Bearer " + f.bobToken}

	code, body := doJSON(t, "GET", f.ts.URL+"/api/v1/settings", adminHeader, nil)
	if code != http.StatusOK {
		t.Fatalf("get settings = %d %v", code, body)
	}
	settings := body["settings"].(map[string]any)
	if settings["registration_mode"] != "closed" {
		t.Fatalf("default registration mode = %v", settings["registration_mode"])
	}

	// Bob (plain user) cannot change settings.
	code, body = doJSON(t, "PATCH", f.ts.URL+"/api/v1/settings", bobHeader,
		map[string]any{"registration_mode": "open"})
	if code != http.StatusForbidden || errCode(t, body) != "ADMIN_REQUIRED" {
		t.Fatalf("bob patch settings = %d %v", code, body)
	}

	// Admin opens registration; the change persists.
	code, body = doJSON(t, "PATCH", f.ts.URL+"/api/v1/settings", adminHeader,
		map[string]any{"registration_mode": "open"})
	if code != http.StatusOK || body["settings"].(map[string]any)["registration_mode"] != "open" {
		t.Fatalf("admin patch = %d %v", code, body)
	}
	code, body = doJSON(t, "GET", f.ts.URL+"/api/v1/settings", adminHeader, nil)
	if body["settings"].(map[string]any)["registration_mode"] != "open" {
		t.Fatalf("setting not persisted: %v", body)
	}

	// Invalid mode is rejected.
	code, _ = doJSON(t, "PATCH", f.ts.URL+"/api/v1/settings", adminHeader,
		map[string]any{"registration_mode": "chaos"})
	if code != http.StatusBadRequest {
		t.Fatalf("invalid mode = %d", code)
	}
}
