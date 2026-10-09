package organizer

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// fakeNetwork is the controlled resolver and dialer these tests run on: a
// check can never reach anything outside this process, while the policy
// still judges the addresses the fake resolver hands out.
type fakeNetwork struct {
	mu      sync.Mutex
	dialed  []string
	lookups int

	// answers is the fake DNS table; addresses are what the policy sees.
	answers map[string][]string
	// local is the in-process test server every dial ends up at.
	local string
}

func (f *fakeNetwork) outbound(allow []*net.IPNet) Outbound {
	return Outbound{
		Allow: allow,
		LookupHost: func(ctx context.Context, host string) ([]string, error) {
			f.mu.Lock()
			f.lookups++
			f.mu.Unlock()
			list, ok := f.answers[host]
			if !ok {
				return nil, fmt.Errorf("fake dns: no such host %q", host)
			}
			return list, nil
		},
		Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			f.mu.Lock()
			f.dialed = append(f.dialed, address)
			f.mu.Unlock()
			var d net.Dialer
			return d.DialContext(ctx, network, f.local)
		},
	}
}

func (f *fakeNetwork) snapshot() (dialed []string, lookups int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.dialed...), f.lookups
}

// newLinkCheckFixture starts an in-process server with the redirect shapes
// an outbound policy has to survive and wires it to a fake network.
func newLinkCheckFixture(t *testing.T, allow []*net.IPNet) (LinkChecker, *fakeNetwork) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/ok", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/gone", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	redirect := func(path, target string) {
		mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, target, http.StatusFound)
		})
	}
	redirect("/to-loopback", "http://127.0.0.1/ok")
	redirect("/to-rfc1918", "http://10.0.0.9/ok")
	redirect("/to-metadata", "http://169.254.169.254/latest/meta-data/")
	redirect("/to-file", "file:///etc/passwd")
	redirect("/to-userinfo", "http://admin:hunter2@93.184.216.34/ok")
	redirect("/to-public", "http://beta.test/ok")
	redirect("/to-itself", "/to-itself")

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	f := &fakeNetwork{
		answers: map[string][]string{
			"alpha.test":   {"93.184.216.34"},
			"beta.test":    {"8.8.8.8"},
			"private.test": {"10.0.0.8"},
			"mixed.test":   {"93.184.216.34", "169.254.169.254"},
			"empty.test":   {},
		},
		local: srv.Listener.Addr().String(),
	}
	return httpChecker(f.outbound(allow)), f
}

func TestLinkCheckFetchesPublicTargetAndDialsTheCheckedAddress(t *testing.T) {
	check, f := newLinkCheckFixture(t, nil)

	out := check(context.Background(), "http://alpha.test/ok")
	if out.StatusClass != "ok_2xx" || out.HTTPStatus != http.StatusOK {
		t.Fatalf("outcome = %+v, want a 200 check", out)
	}
	dialed, lookups := f.snapshot()
	// The connection goes to the resolved address, never back to the name:
	// a second lookup could answer differently.
	if want := []string{"93.184.216.34:80"}; !equalStrings(dialed, want) {
		t.Fatalf("dialed %v, want %v", dialed, want)
	}
	if lookups != 1 {
		t.Fatalf("resolver called %d times, want 1", lookups)
	}
}

func TestLinkCheckStillClassifiesOrdinaryResults(t *testing.T) {
	check, _ := newLinkCheckFixture(t, nil)
	out := check(context.Background(), "http://alpha.test/gone")
	if out.StatusClass != "client_4xx" || out.HTTPStatus != http.StatusNotFound {
		t.Fatalf("outcome = %+v, want client_4xx/404", out)
	}
}

// Refusals must not open a socket at all.
func TestLinkCheckRefusesInternalAndMalformedTargets(t *testing.T) {
	cases := []struct{ name, url string }{
		{"loopback literal", "http://127.0.0.1/ok"},
		{"ipv6 loopback", "http://[::1]/ok"},
		{"mapped loopback", "http://[::ffff:127.0.0.1]/ok"},
		{"link-local metadata", "http://169.254.169.254/latest/meta-data/"},
		{"rfc1918", "http://192.168.1.10/admin"},
		{"cgnat metadata", "http://100.100.100.200/"},
		{"name resolving private", "http://private.test/ok"},
		{"mixed dns answer", "http://mixed.test/ok"},
		{"credentials in url", "http://admin:hunter2@alpha.test/ok"},
		{"file scheme", "file:///etc/passwd"},
		{"gopher scheme", "gopher://127.0.0.1:11211/stats"},
		{"missing scheme", "alpha.test/ok"},
		{"scoped ipv6", "http://[fe80::1%en0]/ok"},
	}
	for _, tc := range cases {
		check, f := newLinkCheckFixture(t, nil)
		out := check(context.Background(), tc.url)
		if out.StatusClass != "network_error" || out.ErrorType != "ssrf_blocked" {
			t.Errorf("%s: outcome = %+v, want network_error/ssrf_blocked", tc.name, out)
		}
		if dialed, _ := f.snapshot(); len(dialed) != 0 {
			t.Errorf("%s: dialled %v, want no connection at all", tc.name, dialed)
		}
	}
}

// A name with no address is a lookup failure, not a policy refusal.
func TestLinkCheckReportsLookupFailureAsNetworkError(t *testing.T) {
	check, _ := newLinkCheckFixture(t, nil)
	for _, raw := range []string{"http://empty.test/ok", "http://unknown.test/ok"} {
		out := check(context.Background(), raw)
		if out.StatusClass != "network_error" || out.ErrorType == "ssrf_blocked" {
			t.Errorf("%s: outcome = %+v, want a plain network error", raw, out)
		}
	}
}

func TestLinkCheckValidatesEveryRedirectHop(t *testing.T) {
	cases := []struct{ name, path string }{
		{"redirect to loopback", "/to-loopback"},
		{"redirect to rfc1918", "/to-rfc1918"},
		{"redirect to metadata", "/to-metadata"},
		{"redirect to file url", "/to-file"},
		{"redirect with credentials", "/to-userinfo"},
	}
	for _, tc := range cases {
		check, f := newLinkCheckFixture(t, nil)
		out := check(context.Background(), "http://alpha.test"+tc.path)
		if out.StatusClass != "network_error" || out.ErrorType != "ssrf_blocked" {
			t.Errorf("%s: outcome = %+v, want ssrf_blocked", tc.name, out)
		}
		// Only the approved first hop was ever connected to.
		if dialed, _ := f.snapshot(); !equalStrings(dialed, []string{"93.184.216.34:80"}) {
			t.Errorf("%s: dialled %v, want only the public first hop", tc.name, dialed)
		}
	}
}

func TestLinkCheckFollowsPublicRedirectChain(t *testing.T) {
	check, f := newLinkCheckFixture(t, nil)
	out := check(context.Background(), "http://alpha.test/to-public")
	if out.StatusClass != "ok_2xx" {
		t.Fatalf("outcome = %+v, want the public hop followed", out)
	}
	if dialed, _ := f.snapshot(); !equalStrings(dialed, []string{"93.184.216.34:80", "8.8.8.8:80"}) {
		t.Fatalf("dialed %v", dialed)
	}

	// The redirect budget is still bounded.
	out = check(context.Background(), "http://alpha.test/to-itself")
	if out.StatusClass == "ok_2xx" {
		t.Fatalf("self-redirecting url = %+v, want a bounded failure", out)
	}
}

// An operator who runs the instance to scan a managed LAN can open exactly
// that range; nothing else comes along with it.
func TestLinkCheckOperatorAllowlistOpensOnlyThatRange(t *testing.T) {
	allow, err := ParseAllowlist([]string{"192.168.7.0/24"})
	if err != nil {
		t.Fatal(err)
	}
	check, f := newLinkCheckFixture(t, allow)

	out := check(context.Background(), "http://192.168.7.5/ok")
	if out.StatusClass != "ok_2xx" {
		t.Fatalf("approved LAN = %+v, want checked", out)
	}
	if dialed, _ := f.snapshot(); !equalStrings(dialed, []string{"192.168.7.5:80"}) {
		t.Fatalf("dialed %v", dialed)
	}

	// Neighbouring private space and the always-denied floor stay closed.
	for _, raw := range []string{"http://192.168.8.5/ok", "http://127.0.0.1/ok", "http://169.254.169.254/"} {
		out := check(context.Background(), raw)
		if out.ErrorType != "ssrf_blocked" {
			t.Errorf("%s: outcome = %+v, want ssrf_blocked", raw, out)
		}
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
