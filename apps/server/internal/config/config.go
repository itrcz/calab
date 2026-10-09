// Package config loads server configuration from environment variables only.
package config

import (
	"errors"
	"fmt"
	"net"
	"net/mail"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/caarlos0/env/v11"
)

// RegistrationMode controls who may create an account.
type RegistrationMode string

// Registration modes (REGISTRATION_MODE).
const (
	RegistrationOpen   RegistrationMode = "open"
	RegistrationInvite RegistrationMode = "invite"
)

// EmailVerificationMode controls whether an unconfirmed email address blocks actions
// (ADR-0065).
type EmailVerificationMode string

// Email verification modes (EMAIL_VERIFICATION).
const (
	// EmailVerificationRequired: creating workspaces, invitations, new DMs etc. need a
	// confirmed address (403 EMAIL_NOT_VERIFIED, ADR-0023).
	EmailVerificationRequired EmailVerificationMode = "required"
	// EmailVerificationOptional: nothing is gated by the confirmation; the address stays
	// unconfirmed and is still never trusted (email invitations, OAuth claims, superadmin).
	EmailVerificationOptional EmailVerificationMode = "optional"
)

// Config is the full server configuration. See apps/server/README.md for the list.
type Config struct {
	IdentityPublicOrigin           string   `env:"IDENTITY_PUBLIC_ORIGIN"`
	IdentityEncryptionKeys         string   `env:"IDENTITY_ENCRYPTION_KEYS"`
	IdentityEncryptionActiveKID    string   `env:"IDENTITY_ENCRYPTION_ACTIVE_KID"`
	OAuthSigningKeys               string   `env:"OAUTH_SIGNING_KEYS"`
	OAuthSigningActiveKID          string   `env:"OAUTH_SIGNING_ACTIVE_KID"`
	IdentityEndpoints              string   `env:"IDENTITY_ENDPOINTS"`
	IdentityDirectoryHosts         string   `env:"IDENTITY_DIRECTORY_HOSTS"`
	IdentityEdition                string   `env:"IDENTITY_EDITION" envDefault:"cloud"`
	IdentityEnterpriseWorkspaceIDs []string `env:"IDENTITY_ENTERPRISE_WORKSPACE_IDS" envSeparator:","`
	HTTPAddr                       string   `env:"HTTP_ADDR" envDefault:"127.0.0.1:3000"`
	PublicAppURL                   string   `env:"PUBLIC_APP_URL" envDefault:"http://localhost:3000"`
	PublicAppURLAlt                string   `env:"PUBLIC_APP_URL_ALT"` // optional second domain of the web client (compatibility)
	// All origins the web client is served from, comma-separated (app host, aliases). The
	// CSRF / gateway Origin checks accept these plus PUBLIC_APP_URL and PUBLIC_APP_URL_ALT;
	// PUBLIC_APP_URL stays the primary one (links).
	PublicAppURLs []string `env:"PUBLIC_APP_URLS" envSeparator:","`
	LogLevel      string   `env:"LOG_LEVEL" envDefault:"info"`

	DatabaseURL string `env:"DATABASE_URL,required"`
	RedisURL    string `env:"REDIS_URL,required"`
	// Namespace of every Valkey key and pub/sub channel of the API, e.g. "calab:" — for a Valkey
	// shared with other applications under an ACL user limited to ~<prefix>* &<prefix>*
	// (docs/06 «Общий Valkey»). Empty = none: the historical names.
	RedisKeyPrefix string `env:"REDIS_KEY_PREFIX"`

	JWTSecret string `env:"JWT_SECRET,required"`
	// Token lifetimes (owner, 2026-09-29: lenient — sign in once a year). Revocation does not
	// wait for expiry: a revoked session's access tokens die at once (Valkey marker + DB
	// recheck, auth/sessioncheck.go). Self-hosted installs may tighten both.
	AccessTokenTTL  time.Duration `env:"ACCESS_TOKEN_TTL" envDefault:"24h"`
	RefreshTokenTTL time.Duration `env:"REFRESH_TOKEN_TTL" envDefault:"8760h"`

	RegistrationMode RegistrationMode `env:"REGISTRATION_MODE" envDefault:"invite"`
	// Whether an unconfirmed address blocks actions (ADR-0065). Without SMTP addresses count
	// as confirmed in either mode.
	EmailVerification EmailVerificationMode `env:"EMAIL_VERIFICATION" envDefault:"required"`

	// Login/register rate limit per client IP (token bucket in Redis).
	AuthRateBurst     int     `env:"AUTH_RATE_BURST" envDefault:"10"`
	AuthRatePerMinute float64 `env:"AUTH_RATE_PER_MINUTE" envDefault:"10"`

	// Login attempts per account (email) per 15 minutes, from any IP.
	LoginAccountBurst int `env:"LOGIN_ACCOUNT_ATTEMPTS" envDefault:"10"`

	// Abuse limits (disk is shared with other tenants of the host).
	MaxWorkspacesPerUser       int   `env:"MAX_WORKSPACES_PER_USER" envDefault:"5"`
	WorkspaceCreatesPerHour    int   `env:"WORKSPACE_CREATES_PER_HOUR" envDefault:"3"`
	StorageMaxTotalBytes       int64 `env:"STORAGE_MAX_TOTAL_BYTES" envDefault:"53687091200"`       // 50 GiB, all files
	DefaultWorkspaceQuotaBytes int64 `env:"DEFAULT_WORKSPACE_QUOTA_BYTES" envDefault:"10737418240"` // 10 GiB per new workspace
	// Personal file quota of notes shelves (ADR-0039) for users without their own.
	DefaultPersonalQuotaBytes int64 `env:"DEFAULT_PERSONAL_QUOTA_BYTES" envDefault:"1073741824"` // 1 GiB

	// Peers allowed to set X-Forwarded-For (Caddy on loopback in prod).
	TrustedProxies []netip.Prefix `env:"TRUSTED_PROXIES" envDefault:"127.0.0.1/32,::1/128"`

	// LiveKit (rtc). All four empty = voice disabled (rtc endpoints answer 503).
	LiveKitURL             string `env:"LIVEKIT_URL"`          // for clients, e.g. wss://rtc.<domain>
	LiveKitInternalURL     string `env:"LIVEKIT_INTERNAL_URL"` // for the API, e.g. http://127.0.0.1:7880
	LiveKitAPIKey          string `env:"LIVEKIT_API_KEY"`
	LiveKitAPISecret       string `env:"LIVEKIT_API_SECRET"`
	LiveKitMaxParticipants uint32 `env:"LIVEKIT_MAX_PARTICIPANTS" envDefault:"50"`

	// Native push is inert unless a complete transport is explicitly configured.
	PushVoIPEnabled           bool   `env:"PUSH_VOIP_ENABLED"`
	PushAPNSKeyFile           string `env:"PUSH_APNS_KEY_FILE"`
	PushAPNSKeyID             string `env:"PUSH_APNS_KEY_ID"`
	PushAPNSTeamID            string `env:"PUSH_APNS_TEAM_ID"`
	PushAPNSAppID             string `env:"PUSH_APNS_APP_ID"`
	PushAPNSEnvironment       string `env:"PUSH_APNS_ENVIRONMENT" envDefault:"production"`
	PushFCMServiceAccountFile string `env:"PUSH_FCM_SERVICE_ACCOUNT_FILE"`
	PushFCMProjectID          string `env:"PUSH_FCM_PROJECT_ID"`
	PushFCMAppID              string `env:"PUSH_FCM_APP_ID"`

	// Link previews: extra address ranges the unfurler may fetch from although they are not
	// public. Only for dev machines whose VPN resolves names into a fake-IP range
	// (e.g. 198.18.0.0/15). Loopback and link-local stay blocked regardless. Never set in prod.
	UnfurlAllowCIDRs []netip.Prefix `env:"UNFURL_ALLOW_CIDRS"`

	// CalDAV (ADR-0041 §4): how often the busy time of a user's connected calendar is imported.
	CalDAVSyncInterval time.Duration `env:"CALDAV_SYNC_INTERVAL" envDefault:"15m"`

	// Gateway.
	HeartbeatInterval time.Duration `env:"GATEWAY_HEARTBEAT_INTERVAL" envDefault:"41s"`
	MaxDevicesPerUser int           `env:"GATEWAY_MAX_SESSIONS_PER_USER" envDefault:"5"`

	// File bytes (ADR-0011): fs = local directory; s3 = S3-compatible bucket (below).
	StorageDriver string `env:"STORAGE_DRIVER" envDefault:"fs"`
	StoragePath   string `env:"STORAGE_PATH" envDefault:"./data/files"`
	MaxFileSizeMB int64  `env:"MAX_FILE_SIZE_MB" envDefault:"50"`
	// HEIC → JPEG for clients without a HEIF decoder (POST /api/files/convert); ffmpeg ≥ 7.1.
	// Not found → the endpoint answers 501 and the client says HEIC is not supported.
	FFmpegPath     string `env:"FFMPEG_PATH" envDefault:"ffmpeg"`
	FFprobePath    string `env:"FFPROBE_PATH" envDefault:"ffprobe"`
	MigrateOnStart bool   `env:"MIGRATE_ON_START" envDefault:"true"`

	// STORAGE_DRIVER=s3 (several API replicas): the files bucket in Yandex Object Storage,
	// Garage, Ceph RGW or another S3-compatible store. Not the S3_* of the release bucket.
	StorageS3Endpoint        string `env:"STORAGE_S3_ENDPOINT"` // https://storage.yandexcloud.net
	StorageS3Region          string `env:"STORAGE_S3_REGION" envDefault:"us-east-1"`
	StorageS3Bucket          string `env:"STORAGE_S3_BUCKET"`
	StorageS3AccessKeyID     string `env:"STORAGE_S3_ACCESS_KEY_ID"`
	StorageS3SecretAccessKey string `env:"STORAGE_S3_SECRET_ACCESS_KEY"`
	StorageS3KeyPrefix       string `env:"STORAGE_S3_KEY_PREFIX"` // optional: objects under "<prefix>/"
	StorageS3ForcePathStyle  bool   `env:"STORAGE_S3_FORCE_PATH_STYLE" envDefault:"true"`

	// Plans (ADR-0024). JSON limits over the built-in defaults, e.g.
	// {"room_members":5,"stream_max_preset":"h720","stream_max_fps":15,"storage_mb":1024}; 0 = no limit.
	PlanFreeLimits string `env:"PLAN_FREE_LIMITS"`
	PlanTeamLimits string `env:"PLAN_TEAM_LIMITS"`
	// Cloud «Business» tier (stored as PLAN_ENTERPRISE).
	PlanBusinessLimits string `env:"PLAN_BUSINESS_LIMITS"`
	// Where to ask for a paid plan: PLAN_CONTACT_URL wins, else mailto:PLAN_CONTACT_EMAIL.
	PlanContactURL   string `env:"PLAN_CONTACT_URL"`
	PlanContactEmail string `env:"PLAN_CONTACT_EMAIL" envDefault:"it@gptunnel.ai"`
	// Product superadmins (comma-separated emails): /api/admin/*, Me.is_superadmin.
	SuperadminEmails []string `env:"SUPERADMIN_EMAILS" envSeparator:","`

	// Mail (ADR-0023). SMTP_HOST empty = no mail: registration marks addresses verified and
	// the mail endpoints answer 503. SMTP_HOST may carry the port ("localhost:1025").
	SMTPHost     string `env:"SMTP_HOST"`
	SMTPPort     int    `env:"SMTP_PORT"`                      // 0 = 587 starttls / 465 tls / 25 none
	SMTPTLS      string `env:"SMTP_TLS" envDefault:"starttls"` // starttls | tls | none
	SMTPUser     string `env:"SMTP_USER"`                      // empty = no AUTH
	SMTPPassword string `env:"SMTP_PASSWORD"`                  //
	SMTPFrom     string `env:"SMTP_FROM"`                      // "Calab <noreply@calab.io>"
	// Meeting recording (ADR-0025). Needs LiveKit and the egress service; the recordings
	// volume is RECORDINGS_PATH here and RECORDING_EGRESS_DIR in the egress container. With
	// STORAGE_DRIVER=s3 there is no such volume: the egress uploads into the files bucket.
	// GPTUNNEL_WEB_URL replaces the host app.gptunnel.ai in links GPTunneL gives (docs/17 §4);
	// RECORDING_KEEP_DAYS: a done recording's audio stays attached to its chat card this long.
	GPTunnelAPIURL    string `env:"GPTUNNEL_API_URL" envDefault:"https://gptunnel.ru"`
	GPTunnelWebURL    string `env:"GPTUNNEL_WEB_URL" envDefault:"https://gptunnel.ru"`
	RecordingKeepDays int    `env:"RECORDING_KEEP_DAYS" envDefault:"30"`
	// TEMP_ROOM_RETENTION_DAYS (ADR-0044): archived temporary rooms are deleted with their
	// history this many days after they closed.
	TempRoomRetentionDays  int    `env:"TEMP_ROOM_RETENTION_DAYS" envDefault:"90"`
	RecordingMaxConcurrent int    `env:"RECORDING_MAX_CONCURRENT" envDefault:"3"`
	RecordingsPath         string `env:"RECORDINGS_PATH" envDefault:"./data/recordings"`
	RecordingEgressDir     string `env:"RECORDING_EGRESS_DIR" envDefault:"/out"`

	// Mail limits: per recipient address and for the whole server, per hour.
	MailPerAddressPerHour int `env:"MAIL_PER_ADDRESS_PER_HOUR" envDefault:"3"`
	MailPerHour           int `env:"MAIL_PER_HOUR" envDefault:"200"`
	// Meeting mail (invitations, changes, cancellations) per address: a bucket of its own.
	MailEventsPerAddressPerHour int `env:"MAIL_EVENTS_PER_ADDRESS_PER_HOUR" envDefault:"10"`

	// Bot API limits per bot (ADR-0031): requests per second (burst = one second's worth) and
	// messages per minute. 0 = the default.
	BotRatePerSec     int `env:"BOT_RATE_PER_SEC" envDefault:"30"`
	BotMessagesPerMin int `env:"BOT_MESSAGES_PER_MIN" envDefault:"20"`

	// Balance billing (ADR-0080 v5): BILLING_* and STRIPE_* (config/billing.go).
	Billing Billing
}

// BotLimits returns the effective bot limits (defaults for 0).
func (c *Config) BotLimits() (perSec, msgsPerMin int) {
	perSec, msgsPerMin = c.BotRatePerSec, c.BotMessagesPerMin
	if perSec <= 0 {
		perSec = 30
	}
	if msgsPerMin <= 0 {
		msgsPerMin = 20
	}
	return perSec, msgsPerMin
}

// PlanContact is the "contact us to buy" link shown to users (ADR-0024).
func (c *Config) PlanContact() string {
	if u := strings.TrimSpace(c.PlanContactURL); u != "" {
		return u
	}
	if e := strings.TrimSpace(c.PlanContactEmail); e != "" {
		return "mailto:" + e
	}
	return ""
}

// Load parses the environment and validates the result.
func Load() (*Config, error) {
	var c Config
	if err := env.Parse(&c); err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	return &c, c.Validate()
}

// Validate checks invariants that env tags cannot express.
func (c *Config) Validate() error {
	if err := c.validateIdentity(); err != nil {
		return err
	}
	var errs []error
	if len(c.JWTSecret) < 32 {
		errs = append(errs, errors.New("JWT_SECRET must be at least 32 bytes"))
	}
	if !validKeyPrefix(c.RedisKeyPrefix) {
		errs = append(errs, fmt.Errorf("REDIS_KEY_PREFIX must be empty or end with ':' and hold only letters, digits, '.', '_', '-' and ':' (at most 64 bytes), got %q", c.RedisKeyPrefix))
	}
	switch c.RegistrationMode {
	case RegistrationOpen, RegistrationInvite:
	default:
		errs = append(errs, fmt.Errorf("REGISTRATION_MODE must be open or invite, got %q", c.RegistrationMode))
	}
	switch c.EmailVerification {
	case "": // a Config built in code: the default, required
		c.EmailVerification = EmailVerificationRequired
	case EmailVerificationRequired, EmailVerificationOptional:
	default:
		errs = append(errs, fmt.Errorf("EMAIL_VERIFICATION must be required or optional, got %q", c.EmailVerification))
	}
	if c.AccessTokenTTL < time.Minute || c.RefreshTokenTTL < c.AccessTokenTTL {
		errs = append(errs, errors.New("ACCESS_TOKEN_TTL must be >= 1m and REFRESH_TOKEN_TTL >= ACCESS_TOKEN_TTL"))
	}
	if c.AuthRateBurst < 1 || c.AuthRatePerMinute <= 0 {
		errs = append(errs, errors.New("AUTH_RATE_BURST must be >= 1 and AUTH_RATE_PER_MINUTE > 0"))
	}
	lk := []string{c.LiveKitURL, c.LiveKitInternalURL, c.LiveKitAPIKey, c.LiveKitAPISecret}
	if n := countSet(lk); n != 0 && n != len(lk) {
		errs = append(errs, errors.New("LIVEKIT_URL, LIVEKIT_INTERNAL_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set together"))
	}
	apns := []string{c.PushAPNSKeyFile, c.PushAPNSKeyID, c.PushAPNSTeamID, c.PushAPNSAppID}
	if n := countSet(apns); n != 0 && n != len(apns) {
		errs = append(errs, errors.New("PUSH_APNS_KEY_FILE, PUSH_APNS_KEY_ID, PUSH_APNS_TEAM_ID and PUSH_APNS_APP_ID must be set together"))
	}
	if countSet(apns) > 0 && c.PushAPNSEnvironment != "production" && c.PushAPNSEnvironment != "development" {
		errs = append(errs, errors.New("PUSH_APNS_ENVIRONMENT must be production or development"))
	}
	fcm := []string{c.PushFCMServiceAccountFile, c.PushFCMProjectID, c.PushFCMAppID}
	if n := countSet(fcm); n != 0 && n != len(fcm) {
		errs = append(errs, errors.New("PUSH_FCM_SERVICE_ACCOUNT_FILE, PUSH_FCM_PROJECT_ID and PUSH_FCM_APP_ID must be set together"))
	}
	if c.HeartbeatInterval < 5*time.Second || c.MaxDevicesPerUser < 1 {
		errs = append(errs, errors.New("GATEWAY_HEARTBEAT_INTERVAL must be >= 5s and GATEWAY_MAX_SESSIONS_PER_USER >= 1"))
	}
	for name, u := range map[string]string{"PUBLIC_APP_URL": c.PublicAppURL, "PUBLIC_APP_URL_ALT": c.PublicAppURLAlt} {
		if u != "" && Origin(u) == "" {
			errs = append(errs, fmt.Errorf("%s must be an absolute http(s) URL, got %q", name, u))
		}
	}
	for _, u := range c.PublicAppURLs {
		if strings.TrimSpace(u) != "" && Origin(u) == "" {
			errs = append(errs, fmt.Errorf("PUBLIC_APP_URLS: %q is not an absolute http(s) URL", u))
		}
	}
	switch c.StorageDriver {
	case "fs":
		if c.StoragePath == "" {
			errs = append(errs, errors.New("STORAGE_PATH is required for STORAGE_DRIVER=fs"))
		}
	case "s3":
		for _, v := range [][2]string{
			{"STORAGE_S3_ENDPOINT", c.StorageS3Endpoint}, {"STORAGE_S3_REGION", c.StorageS3Region},
			{"STORAGE_S3_BUCKET", c.StorageS3Bucket}, {"STORAGE_S3_ACCESS_KEY_ID", c.StorageS3AccessKeyID},
			{"STORAGE_S3_SECRET_ACCESS_KEY", c.StorageS3SecretAccessKey},
		} {
			if strings.TrimSpace(v[1]) == "" {
				errs = append(errs, fmt.Errorf("%s is required for STORAGE_DRIVER=s3", v[0]))
			}
		}
		if c.StorageS3Endpoint != "" && Origin(c.StorageS3Endpoint) == "" {
			errs = append(errs, errors.New("STORAGE_S3_ENDPOINT must be an absolute http(s) URL"))
		}
	default:
		errs = append(errs, fmt.Errorf("STORAGE_DRIVER must be fs or s3, got %q", c.StorageDriver))
	}
	if c.LoginAccountBurst < 1 || c.MaxWorkspacesPerUser < 1 || c.WorkspaceCreatesPerHour < 1 ||
		c.StorageMaxTotalBytes < 1 || c.DefaultWorkspaceQuotaBytes < 0 || c.DefaultPersonalQuotaBytes < 0 {
		errs = append(errs, errors.New("LOGIN_ACCOUNT_ATTEMPTS, MAX_WORKSPACES_PER_USER, WORKSPACE_CREATES_PER_HOUR, STORAGE_MAX_TOTAL_BYTES must be >= 1 and DEFAULT_WORKSPACE_QUOTA_BYTES, DEFAULT_PERSONAL_QUOTA_BYTES >= 0"))
	}
	if c.MaxFileSizeMB < 1 {
		errs = append(errs, errors.New("MAX_FILE_SIZE_MB must be >= 1"))
	}
	if c.SMTPHost != "" {
		switch c.SMTPTLS {
		case "starttls", "tls", "none":
		default:
			errs = append(errs, fmt.Errorf("SMTP_TLS must be starttls, tls or none, got %q", c.SMTPTLS))
		}
		if a, err := mail.ParseAddress(c.SMTPFrom); err != nil || a.Address == "" {
			errs = append(errs, fmt.Errorf("SMTP_FROM must be an email address (\"Calab <noreply@example.com>\") when SMTP_HOST is set, got %q", c.SMTPFrom))
		}
		if c.SMTPPort < 0 || c.SMTPPort > 65535 {
			errs = append(errs, errors.New("SMTP_PORT must be 0..65535"))
		}
		if _, p, err := net.SplitHostPort(c.SMTPHost); err == nil {
			if n, err := strconv.Atoi(p); err != nil || n < 1 || n > 65535 {
				errs = append(errs, fmt.Errorf("SMTP_HOST: bad port %q", p))
			}
		}
		if c.MailPerAddressPerHour < 1 || c.MailPerHour < 1 || c.MailEventsPerAddressPerHour < 1 {
			errs = append(errs, errors.New("MAIL_PER_ADDRESS_PER_HOUR, MAIL_EVENTS_PER_ADDRESS_PER_HOUR and MAIL_PER_HOUR must be >= 1"))
		}
	}
	if Origin(c.GPTunnelAPIURL) == "" {
		errs = append(errs, fmt.Errorf("GPTUNNEL_API_URL must be an absolute http(s) URL, got %q", c.GPTunnelAPIURL))
	}
	if Origin(c.GPTunnelWebURL) == "" {
		errs = append(errs, fmt.Errorf("GPTUNNEL_WEB_URL must be an absolute http(s) URL, got %q", c.GPTunnelWebURL))
	}
	if c.CalDAVSyncInterval != 0 && (c.CalDAVSyncInterval < time.Minute || c.CalDAVSyncInterval > 24*time.Hour) {
		errs = append(errs, fmt.Errorf("CALDAV_SYNC_INTERVAL must be between 1m and 24h, got %s", c.CalDAVSyncInterval))
	}
	if c.RecordingKeepDays < 1 || c.RecordingKeepDays > 3650 {
		errs = append(errs, errors.New("RECORDING_KEEP_DAYS must be 1..3650"))
	}
	if c.TempRoomRetentionDays < 1 || c.TempRoomRetentionDays > 3650 {
		errs = append(errs, errors.New("TEMP_ROOM_RETENTION_DAYS must be 1..3650"))
	}
	if c.RecordingMaxConcurrent < 1 {
		errs = append(errs, errors.New("RECORDING_MAX_CONCURRENT must be >= 1"))
	}
	// The recordings volume shared with the egress; with s3 recordings go to the files bucket.
	if c.StorageDriver != "s3" && (c.RecordingsPath == "" || !strings.HasPrefix(c.RecordingEgressDir, "/")) {
		errs = append(errs, errors.New("RECORDINGS_PATH must be set and RECORDING_EGRESS_DIR an absolute path (STORAGE_DRIVER=fs)"))
	}
	if err := c.Billing.validate(); err != nil {
		errs = append(errs, err)
	}
	if c.BotRatePerSec < 0 || c.BotRatePerSec > 10000 || c.BotMessagesPerMin < 0 || c.BotMessagesPerMin > 100000 {
		errs = append(errs, errors.New("BOT_RATE_PER_SEC must be 0..10000 and BOT_MESSAGES_PER_MIN 0..100000 (0 = default)"))
	}
	if err := errors.Join(errs...); err != nil {
		return fmt.Errorf("config: %w", err)
	}
	return nil
}

// validKeyPrefix: REDIS_KEY_PREFIX is empty or a plain name ending with ':'. No glob characters
// (the gateway PSUBSCRIBEs to "<prefix>*", the ACL user gets ~<prefix>*), and the final ':'
// keeps "calab:*" from also matching the keys of another application named "calabash".
func validKeyPrefix(p string) bool {
	if p == "" {
		return true
	}
	if len(p) > 64 || !strings.HasSuffix(p, ":") {
		return false
	}
	for _, r := range p {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', strings.ContainsRune("._-:", r):
		default:
			return false
		}
	}
	return true
}

// AllowedOrigins returns the browser origins of the web client (scheme://host[:port]),
// used for CSRF checks on cookie-authenticated requests and for gateway upgrades.
// Sources: PUBLIC_APP_URL, PUBLIC_APP_URL_ALT and PUBLIC_APP_URLS, deduplicated in order.
func (c *Config) AllowedOrigins() []string {
	var out []string
	seen := map[string]bool{}
	for _, u := range append([]string{c.PublicAppURL, c.PublicAppURLAlt}, c.PublicAppURLs...) {
		if o := Origin(u); o != "" && !seen[o] {
			seen[o] = true
			out = append(out, o)
		}
	}
	return out
}

// Origin normalizes a URL to its origin; "" if it is not an absolute http(s) URL.
func Origin(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return ""
	}
	return strings.ToLower(u.Scheme + "://" + u.Host)
}

// MailEnabled reports whether SMTP is configured.
func (c *Config) MailEnabled() bool { return c.SMTPHost != "" }

// LiveKitEnabled reports whether voice is configured.
func (c *Config) LiveKitEnabled() bool { return c.LiveKitAPIKey != "" }

func countSet(ss []string) int {
	n := 0
	for _, s := range ss {
		if s != "" {
			n++
		}
	}
	return n
}
