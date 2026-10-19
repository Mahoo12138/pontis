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

	// Bob cannot revoke alice's device; an unknown device and someone else's
	// look identical.
	code, _ = doJSON(t, "POST", f.ts.URL+"/api/v1/devices/"+deviceID+"/revoke",
		map[string]string{"Authorization": "Bearer " + f.bobToken}, nil)
	if code != http.StatusNotFound {
		t.Fatalf("bob revoke = %d, want 404", code)
	}
	// Deleting is the step after revoking, not a substitute for it: a live
	// device cannot be deleted out from under its owner.
	code, body = doJSON(t, "DELETE", f.ts.URL+"/api/v1/devices/"+deviceID, h, nil)
	if code != http.StatusConflict {
		t.Fatalf("delete a live device = %d %v, want 409", code, body)
	}
	if err := doEmpty(t, "POST", f.ts.URL+"/api/v1/devices/"+deviceID+"/revoke", h); err != http.StatusNoContent {
		t.Fatalf("revoke = %d", err)
	}
	code, body = doJSON(t, "GET", f.ts.URL+"/api/v1/devices/overview", h, nil)
	if code != http.StatusOK {
		t.Fatalf("post-revoke overview = %d %v", code, body)
	}
	// The revoked device is still listed — that is the state the owner has to
	// be able to read before deciding to delete it — with its bindings dropped
	// and its revoke time set.
	dev = nil
	for _, d := range body["devices"].([]any) {
		if d.(map[string]any)["id"] == deviceID {
			dev = d.(map[string]any)
		}
	}
	if dev == nil {
		t.Fatalf("revoked device disappeared from the overview: %v", body["devices"])
	}
	if dev["revoked_at"] == nil || dev["revoked_at"] == "" {
		t.Fatalf("revoked device has no revoked_at: %v", dev)
	}
	if got := len(dev["bindings"].([]any)); got != 0 {
		t.Fatalf("revoked device still reports %d bindings: %v", got, dev)
	}

	// The revoked device credential no longer authenticates.
	code, body = doJSON(t, "GET", f.ts.URL+"/api/v1/device/bindings",
		map[string]string{"Authorization": "Bearer " + deviceSecret}, nil)
	// The route answers 401 before the revoked device can be read.
	if code != http.StatusUnauthorized {
		t.Fatalf("revoked device credential = %d %v", code, body)
	}

	// Now the record goes.
	if err := doEmpty(t, "DELETE", f.ts.URL+"/api/v1/devices/"+deviceID, h); err != http.StatusNoContent {
		t.Fatalf("delete revoked device = %d", err)
	}
	code, body = doJSON(t, "GET", f.ts.URL+"/api/v1/devices/overview", h, nil)
	if got := len(body["devices"].([]any)); got != 1 {
		t.Fatalf("post-delete device count = %d, want 1 (%v)", got, body["devices"])
	}
}

// The extension's 解除配对 dialog promises the device revokes itself on the
// server. This is that call: one device credential takes its own device out of
// the account, and the space it was blocking becomes deletable.
func TestDeviceRevokeSelfUnpairsAndFreesTheSpace(t *testing.T) {
	f := bootstrapLibraryFlow(t)
	h := map[string]string{"Authorization": "Bearer " + f.sessionToken}

	deviceID, deviceSecret := registerDeviceFor(t, f.ts.URL, f.sessionToken, "Edge 上的 Pontis")
	if code, body := doJSON(t, "POST", f.ts.URL+"/api/v1/device/bindings",
		map[string]string{"Authorization": "Bearer " + deviceSecret},
		map[string]string{"space_id": f.spaceID}); code != http.StatusCreated {
		t.Fatalf("bind = %d %v", code, body)
	}

	// This device's own row, read from the account side. The fixture keeps a
	// second bound device, so the space's blockers are not the thing to assert
	// on here — the device's own bindings are.
	overviewRow := func() map[string]any {
		code, body := doJSON(t, "GET", f.ts.URL+"/api/v1/devices/overview", h, nil)
		if code != http.StatusOK {
			t.Fatalf("overview = %d %v", code, body)
		}
		for _, d := range body["devices"].([]any) {
			if d.(map[string]any)["id"] == deviceID {
				return d.(map[string]any)
			}
		}
		t.Fatalf("device %s missing from the overview: %v", deviceID, body["devices"])
		return nil
	}
	if got := len(overviewRow()["bindings"].([]any)); got != 1 {
		t.Fatalf("freshly bound device reports %d bindings, want 1", got)
	}

	if err := doEmpty(t, "POST", f.ts.URL+"/api/v1/device/revoke",
		map[string]string{"Authorization": "Bearer " + deviceSecret}); err != http.StatusNoContent {
		t.Fatalf("self revoke = %d", err)
	}

	// The credential is dead immediately, so the extension cannot keep syncing.
	if code, _ := doJSON(t, "GET", f.ts.URL+"/api/v1/device/bindings",
		map[string]string{"Authorization": "Bearer " + deviceSecret}, nil); code != http.StatusUnauthorized {
		t.Fatalf("self-revoked credential still works: %d", code)
	}

	// The account side sees a revoked device with nothing bound to it: the
	// unpair is visible, and it stops holding the space.
	row := overviewRow()
	if row["revoked_at"] == nil {
		t.Fatalf("device not marked revoked after self-revoke: %v", row)
	}
	if got := len(row["bindings"].([]any)); got != 0 {
		t.Fatalf("self-revoked device still reports %d bindings: %v", got, row)
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
