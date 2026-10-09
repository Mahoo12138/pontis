package organizer

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
)

// ErrBlocked reports that the outbound policy refused an address. It
// reaches the caller through the http client error chain, so a refused
// check is classified as blocked rather than as an ordinary network
// failure.
var ErrBlocked = errors.New("organizer: address not permitted")

// Outbound is the network policy a server-side link check has to satisfy.
// The check runs with the server's own network identity, which sits inside
// networks the bookmark owner may not reach; therefore everything that is
// not publicly routable is denied by default and only the instance
// operator can open a managed range back up.
type Outbound struct {
	// Allow lists ranges the operator opted into, e.g. the LAN that the
	// deployment is meant to scan. It can open private space; it can never
	// open loopback, link-local (the cloud metadata service answers there),
	// multicast or the unspecified address.
	Allow []*net.IPNet

	// LookupHost replaces the system resolver. Tests inject a controlled
	// one; production leaves it nil.
	LookupHost func(ctx context.Context, host string) ([]string, error)

	// Dial makes the final connection, always to an address that already
	// passed the policy. Tests inject a controlled dialer so a check never
	// leaves the machine; production leaves it nil.
	Dial func(ctx context.Context, network, address string) (net.Conn, error)
}

func (ob Outbound) resolver() func(context.Context, string) ([]string, error) {
	if ob.LookupHost != nil {
		return ob.LookupHost
	}
	return net.DefaultResolver.LookupHost
}

// ParseAllowlist turns operator-supplied CIDRs or plain addresses into a
// policy. A malformed entry is an error: silently dropping one would widen
// access instead of narrowing it.
func ParseAllowlist(entries []string) ([]*net.IPNet, error) {
	var out []*net.IPNet
	for _, raw := range entries {
		entry := strings.TrimSpace(raw)
		if entry == "" {
			continue
		}
		if ip := net.ParseIP(entry); ip != nil {
			bits := 8 * len(ip.To16())
			if v4 := ip.To4(); v4 != nil {
				ip = v4
				bits = 32
			}
			out = append(out, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
			continue
		}
		_, netBlock, err := net.ParseCIDR(entry)
		if err != nil {
			return nil, fmt.Errorf("organizer: bad allowlist entry %q", entry)
		}
		out = append(out, netBlock)
	}
	return out, nil
}

// neverAllowed cannot be opened by configuration.
var neverAllowed = mustParseNets(
	"0.0.0.0/8",      // "this host", includes the unspecified address
	"127.0.0.0/8",    // loopback
	"169.254.0.0/16", // link-local; cloud metadata IPs answer here
	"::1/128",
	"::/128",    // unspecified
	"fe80::/10", // link-local
	"224.0.0.0/4",
	"ff00::/8", // multicast
)

// deniedByDefault is non-public space. An operator allowlist entry can
// reopen a range here.
var deniedByDefault = mustParseNets(
	"10.0.0.0/8",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"fc00::/7",        // IPv6 unique local address
	"100.64.0.0/10",   // CGNAT; carries provider metadata endpoints
	"198.18.0.0/15",   // benchmarking
	"192.0.2.0/24",    // documentation
	"198.51.100.0/24", // documentation
	"203.0.113.0/24",  // documentation
	"192.88.99.0/24",  // 6to4 relay anycast
	"2002::/16",       // 6to4: embeds an IPv4 address that To4() will not unwrap
	"2001::/32",       // Teredo: embeds an obfuscated IPv4 address
	"2001:db8::/32",   // documentation
)

func mustParseNets(entries ...string) []*net.IPNet {
	out, err := ParseAllowlist(entries)
	if err != nil {
		panic(err)
	}
	return out
}

// Blocked reports why this address may not be contacted. An address that
// appears in the operator allowlist is permitted unless it also falls in
// neverAllowed.
func (ob Outbound) Blocked(ip net.IP) error {
	if ip == nil {
		return fmt.Errorf("%w: not an address", ErrBlocked)
	}
	// Judge an IPv4-in-IPv6 form as the IPv4 it carries, so a mapped
	// loopback or metadata address cannot slip past the IPv4 rules.
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	for _, block := range neverAllowed {
		if block.Contains(ip) {
			return fmt.Errorf("%w: %s is reserved", ErrBlocked, ip)
		}
	}
	for _, block := range ob.Allow {
		if block.Contains(ip) {
			return nil
		}
	}
	for _, block := range deniedByDefault {
		if block.Contains(ip) {
			return fmt.Errorf("%w: %s is not publicly routable", ErrBlocked, ip)
		}
	}
	return nil
}

// validateTarget resolves host and returns the address the connection is
// allowed to be made to. Every answer is checked, not just the first: a
// public name with one private record is the classic way to reach an
// internal service.
func (ob Outbound) validateTarget(ctx context.Context, host string) (string, error) {
	if host == "" {
		return "", fmt.Errorf("%w: empty host", ErrBlocked)
	}
	if ip := net.ParseIP(host); ip != nil {
		if err := ob.Blocked(ip); err != nil {
			return "", err
		}
		return canonicalHost(ip), nil
	}
	if strings.ContainsRune(host, '%') {
		// A scoped IPv6 address names an interface on the server itself.
		return "", fmt.Errorf("%w: address scope %q", ErrBlocked, host)
	}
	addresses, err := ob.resolver()(ctx, host)
	if err != nil {
		return "", fmt.Errorf("organizer: resolve %q: %w", host, err)
	}
	if len(addresses) == 0 {
		return "", fmt.Errorf("organizer: resolve %q: no addresses", host)
	}
	for _, raw := range addresses {
		ip := net.ParseIP(raw)
		if ip == nil {
			return "", fmt.Errorf("%w: %q resolved to a non-address %q", ErrBlocked, host, raw)
		}
		if err := ob.Blocked(ip); err != nil {
			return "", err
		}
	}
	return canonicalHost(net.ParseIP(addresses[0])), nil
}

func canonicalHost(ip net.IP) string {
	if v4 := ip.To4(); v4 != nil {
		return v4.String()
	}
	return ip.String()
}

// validateURL applies the checks that a dial target cannot express: only
// http and https are fetched at all, and no credential may ride along in
// the URL.
func validateURL(rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("%w: unparsable url", ErrBlocked)
	}
	return validateTargetURL(u)
}

// validateTargetURL is the same rule for a url already in hand, which is
// what each redirect hop arrives as.
func validateTargetURL(u *url.URL) error {
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("%w: scheme %q is not fetchable", ErrBlocked, u.Scheme)
	}
	if u.User != nil {
		return fmt.Errorf("%w: credentials in the url", ErrBlocked)
	}
	if u.Hostname() == "" {
		return fmt.Errorf("%w: no host", ErrBlocked)
	}
	return nil
}
