package httpapi

// Deployment mode: which address the instance is really reached at, whether
// the request arrived over TLS, and which peers may say so on our behalf.
//
// Two things consume it: the session cookie gets `Secure` only when the
// deployment is actually HTTPS, and a cookie-authenticated state-changing
// request has to come from the same origin the app was served from. Neither is
// possible while `public_url` and `trusted_proxies` are parsed and then ignored.

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// Deployment is the parsed deployment-mode configuration.
type Deployment struct {
	// PublicURL is the externally visible base URL, e.g. https://bm.example.
	// Empty means "answer from whatever Host the request carried", which is
	// correct for a same-origin install and for plain http://localhost.
	PublicURL string
	// Proxies are the peer addresses whose X-Forwarded-* headers may be
	// trusted. Empty means no proxy is in front, so a spoofed
	// X-Forwarded-Proto from an arbitrary client changes nothing.
	Proxies []*net.IPNet
}

// ParseProxies reads trusted_proxies entries: bare IPs and CIDR blocks both.
func ParseProxies(entries []string) ([]*net.IPNet, error) {
	var out []*net.IPNet
	for _, raw := range entries {
		entry := strings.TrimSpace(raw)
		if entry == "" {
			continue
		}
		if ip := net.ParseIP(entry); ip != nil {
			bits := 8 * len(ip.To16())
			if v4 := ip.To4(); v4 != nil {
				ip, bits = v4, 32
			}
			out = append(out, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
			continue
		}
		_, block, err := net.ParseCIDR(entry)
		if err != nil {
			return nil, fmt.Errorf("config: bad trusted_proxies entry %q", entry)
		}
		out = append(out, block)
	}
	return out, nil
}

// Validate rejects a malformed public_url at boot rather than at the first
// login that would have needed it.
func (d Deployment) Validate() error {
	if d.PublicURL == "" {
		return nil
	}
	u, err := url.Parse(d.PublicURL)
	if err != nil {
		return fmt.Errorf("config: public_url %q: %w", d.PublicURL, err)
	}
	if u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return fmt.Errorf("config: public_url %q must be an absolute http(s) URL", d.PublicURL)
	}
	return nil
}

// Origin returns the configured external origin (scheme://host[:port]), or ""
// when the instance answers from the request's own Host.
func (d Deployment) Origin() string {
	if d.PublicURL == "" {
		return ""
	}
	u, err := url.Parse(d.PublicURL)
	if err != nil || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

// fromTrustedProxy reports whether this request arrived over a peer we accept
// forwarding headers from.
func (d Deployment) fromTrustedProxy(r *http.Request) bool {
	if len(d.Proxies) == 0 {
		return false
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	for _, block := range d.Proxies {
		if block.Contains(ip) {
			return true
		}
	}
	return false
}

// scheme is how this request will look to a browser: https when TLS ended here,
// or when a trusted proxy says it terminated there. An untrusted peer's
// X-Forwarded-Proto is ignored, because otherwise any client could make the
// server emit a `Secure` cookie over a plaintext connection — or, flipped the
// other way, mark a real HTTPS session as downgradeable.
func (d Deployment) scheme(r *http.Request) string {
	if d.PublicURL != "" {
		if u, err := url.Parse(d.PublicURL); err == nil && u.Scheme != "" {
			return u.Scheme
		}
	}
	if r.TLS != nil {
		return "https"
	}
	if d.fromTrustedProxy(r) {
		if first := firstForwardedValue(r.Header.Get("X-Forwarded-Proto")); first == "https" {
			return "https"
		}
	}
	return "http"
}

// IsHTTPS drives the cookie's Secure attribute.
func (d Deployment) IsHTTPS(r *http.Request) bool { return d.scheme(r) == "https" }

// authority is the host[:port] a browser-side origin must match.
func (d Deployment) authority(r *http.Request) string {
	if origin := d.Origin(); origin != "" {
		if u, err := url.Parse(origin); err == nil {
			return u.Host
		}
	}
	return r.Host
}

// sameOrigin is the CSRF boundary for ambient credentials. Requests that
// authenticate with a bearer secret are not checked at all: a cross-site page
// cannot make the browser attach a device or API token on its own, so there is
// nothing to forge.
//
// A missing Origin is accepted. A browser sends Origin on every cross-site
// POST, including a top-level form submission, and SameSite=Lax already stops
// the session cookie from riding along with the one case that reaches
// same-site-but-foreign (a subdomain) — so what is left without an Origin is
// non-browser tooling using a cookie it legitimately holds.
func (d Deployment) sameOrigin(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	want := d.authority(r)
	if strings.EqualFold(parsed.Host, want) {
		return true
	}
	// The dev server runs on its own port and proxies /api to the server, so
	// the browser's origin and the Host the server sees differ by port alone —
	// `pnpm dev` would otherwise be locked out by this very check. Only the
	// loopback names qualify, and only when both sides are loopback: a
	// page on http://localhost:5173 can already reach this machine, so the
	// allowance costs nothing that the network exposure of :8080 does not.
	return isLoopbackHost(parsed.Hostname()) && isLoopbackHost(hostOnly(want))
}

func hostOnly(authority string) string {
	if h, _, err := net.SplitHostPort(authority); err == nil {
		return h
	}
	return authority
}

func isLoopbackHost(host string) bool {
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return host == "localhost"
}

func firstForwardedValue(v string) string {
	if i := strings.IndexByte(v, ','); i >= 0 {
		v = v[:i]
	}
	return strings.ToLower(strings.TrimSpace(v))
}

// isSafeMethod cannot change state, so it is outside the origin check.
func isSafeMethod(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	default:
		return false
	}
}

// sessionCookie builds the web session cookie for this request.
//
// `Secure` is decided per deployment instead of hardcoded, in both directions:
// set it always and logins silently never work on a plain-http install; leave
// it off and an HTTPS instance ships its session token over any downgrade.
// Lax is kept rather than Strict because the extension pairs from a top-level
// navigation to this origin, and Strict would drop the cookie there.
func (s *Server) sessionCookie(r *http.Request, value string) *http.Cookie {
	return &http.Cookie{
		Name:     SessionCookie,
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		Secure:   s.Deploy.IsHTTPS(r),
		SameSite: http.SameSiteLaxMode,
	}
}
