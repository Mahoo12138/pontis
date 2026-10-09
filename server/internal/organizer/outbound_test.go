package organizer

import (
	"net"
	"testing"
)

func TestOutboundDeniesNonPublicAddresses(t *testing.T) {
	ob := Outbound{}
	blocked := []string{
		"127.0.0.1", "127.1.2.3", // loopback
		"::1",           // IPv6 loopback
		"0.0.0.0", "::", // unspecified
		"10.0.0.8", "172.16.5.4", "192.168.1.1", // RFC1918
		"fd12:3456:789a::1",             // IPv6 ULA
		"169.254.169.254",               // cloud metadata
		"fe80::1",                       // IPv6 link-local
		"100.64.0.1", "100.100.100.200", // CGNAT, provider metadata
		"198.18.0.1", // benchmarking
		"192.0.2.1", "198.51.100.1", "203.0.113.1",
		"192.88.99.1",          // 6to4 relay anycast
		"2002:7f00:1::",        // 6to4 carrying 127.0.0.1
		"2001:0000:4136::1",    // Teredo space
		"2001:db8::1",          // documentation
		"224.0.0.5", "ff02::1", // multicast
	}
	for _, raw := range blocked {
		ip := net.ParseIP(raw)
		if ip == nil {
			t.Fatalf("bad test address %q", raw)
		}
		if err := ob.Blocked(ip); err == nil {
			t.Errorf("%s: allowed, want denied", raw)
		}
	}

	allowed := []string{"93.184.216.34", "8.8.8.8", "1.1.1.1", "2606:2800:220:1:248:1893:25c8:1946"}
	for _, raw := range allowed {
		if err := ob.Blocked(net.ParseIP(raw)); err != nil {
			t.Errorf("%s: %v, want publicly routable", raw, err)
		}
	}
}

// An IPv4-in-IPv6 form must be judged as the IPv4 it carries, otherwise
// http://[::ffff:127.0.0.1]/ walks past the loopback rule.
func TestOutboundJudgesMappedIPv4AsIPv4(t *testing.T) {
	for _, raw := range []string{"::ffff:127.0.0.1", "::ffff:10.0.0.8", "::ffff:169.254.169.254"} {
		if err := (Outbound{}).Blocked(net.ParseIP(raw)); err == nil {
			t.Errorf("%s: allowed, want denied", raw)
		}
	}
}

// The allowlist is the operator's switch for a managed LAN. It can open
// private space; it cannot open the addresses that always point at the
// server itself or its metadata service.
func TestOutboundAllowlistCannotOpenTheDeniedFloor(t *testing.T) {
	allow, err := ParseAllowlist([]string{"192.168.7.0/24", "127.0.0.0/8", "169.254.0.0/16"})
	if err != nil {
		t.Fatalf("ParseAllowlist: %v", err)
	}
	ob := Outbound{Allow: allow}

	if err := ob.Blocked(net.ParseIP("192.168.7.20")); err != nil {
		t.Errorf("approved LAN: %v, want allowed", err)
	}
	for _, raw := range []string{"127.0.0.1", "169.254.169.254", "::1", "fe80::1", "0.0.0.0"} {
		if err := ob.Blocked(net.ParseIP(raw)); err == nil {
			t.Errorf("%s: allowed by configuration, must stay denied", raw)
		}
	}
	// A range that was not named stays closed.
	if err := ob.Blocked(net.ParseIP("192.168.8.1")); err == nil {
		t.Errorf("192.168.8.1: allowed, want denied (outside the approved range)")
	}
}

func TestParseAllowlist(t *testing.T) {
	nets, err := ParseAllowlist([]string{"10.0.0.0/8", " 192.168.1.50 ", ""})
	if err != nil {
		t.Fatalf("ParseAllowlist: %v", err)
	}
	if len(nets) != 2 {
		t.Fatalf("parsed %d entries, want 2 (blank skipped)", len(nets))
	}
	if !nets[1].Contains(net.ParseIP("192.168.1.50")) || nets[1].Contains(net.ParseIP("192.168.1.51")) {
		t.Errorf("bare address entry = %v, want a single-host range", nets[1])
	}

	for _, bad := range []string{"10.0.0.0/33", "not-a-range", "10.0.0.0/8/8"} {
		if _, err := ParseAllowlist([]string{bad}); err == nil {
			t.Errorf("%q parsed cleanly, want an error", bad)
		}
	}
}

func TestValidateURL(t *testing.T) {
	for _, raw := range []string{
		"http://example.test/", "https://example.test:8443/a",
	} {
		if err := validateURL(raw); err != nil {
			t.Errorf("%s: %v, want accepted", raw, err)
		}
	}
	for _, raw := range []string{
		"file:///etc/passwd",
		"gopher://127.0.0.1:11211/stats",
		"ftp://internal.test/",
		"http://admin:hunter2@example.test/",
		"http:///no-host",
		"example.test/no-scheme",
	} {
		if err := validateURL(raw); err == nil {
			t.Errorf("%s: accepted, want refused", raw)
		}
	}
}
