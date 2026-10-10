// Package app wires dependencies and routes into one http.Handler. Used by cmd/server
// and by integration tests.
package app

import (
	"context"
	"net/http"
	"net/netip"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/rueidis"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/achievements"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/billing"
	"github.com/calaba/calaba/server/internal/birthdays"
	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/boards"
	"github.com/calaba/calaba/server/internal/bots"
	"github.com/calaba/calaba/server/internal/buildinfo"
	"github.com/calaba/calaba/server/internal/caldav"
	"github.com/calaba/calaba/server/internal/calendar"
	"github.com/calaba/calaba/server/internal/calls"
	"github.com/calaba/calaba/server/internal/config"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/directory"
	"github.com/calaba/calaba/server/internal/dms"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/files"
	"github.com/calaba/calaba/server/internal/gateway"
	"github.com/calaba/calaba/server/internal/gptunnel"
	"github.com/calaba/calaba/server/internal/guests"
	"github.com/calaba/calaba/server/internal/health"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/mail"
	"github.com/calaba/calaba/server/internal/messages"
	"github.com/calaba/calaba/server/internal/moderation"
	"github.com/calaba/calaba/server/internal/notes"
	"github.com/calaba/calaba/server/internal/oauthprovider"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/calaba/calaba/server/internal/push"
	"github.com/calaba/calaba/server/internal/recording"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/rooms"
	"github.com/calaba/calaba/server/internal/rtc"
	"github.com/calaba/calaba/server/internal/search"
	"github.com/calaba/calaba/server/internal/sip"
	"github.com/calaba/calaba/server/internal/sounds"
	"github.com/calaba/calaba/server/internal/sso"
	"github.com/calaba/calaba/server/internal/stickers"
	"github.com/calaba/calaba/server/internal/superadmin"
	"github.com/calaba/calaba/server/internal/unfurl"
	"github.com/calaba/calaba/server/internal/users"
	"github.com/calaba/calaba/server/internal/voice"
	"github.com/calaba/calaba/server/internal/workspaces"
)

// Deps are the long-lived dependencies of the server.
type Deps struct {
	IdentityEndpointPolicy   sso.EndpointPolicy
	IdentityDirectoryScanner directory.Scanner
	Config                   *config.Config
	DB                       *db.DB
	Redis                    rueidis.Client
	Events                   events.Publisher
	Blob                     blob.Store
	// LiveKit overrides the LiveKit client (tests); nil = real client from config.
	LiveKit rtc.LiveKit
	// UnfurlAllowAddr overrides the link-preview address policy (tests only, to reach a
	// loopback test server); nil = public addresses only. Deliberately not an env var.
	UnfurlAllowAddr func(netip.Addr) bool
	// Mail overrides the mail transport (tests: mail.Fake); nil = SMTP from config, or no
	// mail when SMTP_HOST is empty.
	Mail mail.Sender
	// Egress overrides the LiveKit Egress client (tests); nil = real client from config.
	Egress rtc.Egress
	// BotWebhooks tunes bot webhook delivery (tests: TLS roots of a test server, short
	// backoff); the zero value is production. The address policy is UnfurlAllowAddr's.
	BotWebhooks bots.WebhookOptions
	// CalDAV tunes the CalDAV client and workers (tests: TLS roots, short polls); the zero
	// value is production. The address policy is UnfurlAllowAddr's.
	CalDAV caldav.Options
	// SIP overrides the LiveKit SIP API client (tests); nil = real client from config.
	SIP rtc.SIP
	// SIPOptions tune telephony (tests: address policy, DNS, short timings); the zero value is
	// production with the address policy of UnfurlAllowAddr.
	SIPOptions sip.Options
	// Push transports override provider clients in local deterministic tests.
	Push map[v1.PushProvider]push.Provider
	// Seats is the paid-seat hook of admission (ADR-0080, billing.Seats). nil = billing.NoSeats;
	// it is used only with BILLING_ENABLED.
	Seats billing.Seats
}

// BlobConfig is the file store of the configuration (STORAGE_*, ADR-0011).
func BlobConfig(c *config.Config) blob.Config {
	return blob.Config{Driver: c.StorageDriver, Path: c.StoragePath, S3: blob.S3Config{
		Endpoint: c.StorageS3Endpoint, Region: c.StorageS3Region, Bucket: c.StorageS3Bucket,
		AccessKeyID: c.StorageS3AccessKeyID, SecretAccessKey: c.StorageS3SecretAccessKey,
		KeyPrefix: c.StorageS3KeyPrefix, ForcePathStyle: c.StorageS3ForcePathStyle,
	}}
}

// App is the assembled server.
type App struct {
	SSO       *sso.Service
	Directory *directory.Service
	OAuth     *oauthprovider.Service
	Handler   http.Handler
	Auth      *auth.Service
	Gateway   *gateway.Hub
	Files     *files.Service
	Guests    *guests.Service
	RTC       *rtc.Service // nil when LiveKit is not configured
	Plans     *plans.Service
	Mail      *mail.Service
	// Recording: meeting recording and GPTunneL (ADR-0025).
	Recording *recording.Service
	// Search: unified search (ADR-0062).
	Search *search.Service
	// Bots: bots and the Bot API (ADR-0031), with the webhook worker.
	Bots *bots.Service
	// BoardWebhooks: the board webhook worker (ADR-0058 §4).
	BoardWebhooks *boards.Webhooks
	// Birthdays: the hourly birthday-card worker (docs/09 #76).
	Birthdays *birthdays.Service
	// Achievements: catalogs and grants (ADR-0061); its startup task finishes migration 00063.
	Achievements *achievements.Service
	// Calls: one-to-one calls (ADR-0034) with their ring / lost timers.
	Calls *calls.Service
	Push  *push.Service
	// Calendar: meetings (ADR-0038) with the reminder / room badge sweeper.
	Calendar *calendar.Service
	// CalDAV: the users' CalDAV calendars (ADR-0041) with the import sweeper and push worker.
	CalDAV *caldav.Service
	// Boards: task boards (ADR-0042) with the auto-archive sweeper.
	Boards *boards.Service
	// Rooms: room handlers with the temporary rooms sweeper (ADR-0044).
	Rooms *rooms.Handlers
	// SIP: telephony (ADR-0046) with the lost-call sweeper.
	SIP        *sip.Service
	billing    *billingRuntime
	redis      rueidis.Client
	identityDB *db.DB
	// tempRetention: TEMP_ROOM_RETENTION_DAYS.
	tempRetention time.Duration
	// Routes: every registered route pattern (the bot route table test).
	Routes []string
}

// Run starts background work (gateway fan-out, presence sweeper, orphan file cleanup,
// voice reconcile) until ctx is done.
func (a *App) Run(ctx context.Context) {
	go a.Gateway.Run(ctx)
	go a.runIdentityInvalidations(ctx)
	if a.Directory != nil {
		go a.runIdentityDirectory(ctx)
	}
	go a.Files.RunCleanup(ctx, time.Hour)
	go a.Files.RunStorageMetrics(ctx, time.Minute)
	go a.Guests.RunCleanup(ctx, time.Hour)
	go a.Guests.RunAdmissions(ctx, guests.AdmissionSweep)
	go a.Plans.Run(ctx)
	if a.RTC != nil {
		go a.RTC.RunReconcile(ctx, 30*time.Second)
		go a.RTC.RunIdentityEnforcement(ctx)
	}
	go a.Mail.Run(ctx) // returns at once without mail
	go a.Recording.Run(ctx)
	go a.Recording.BackfillTranscripts(ctx) // one-shot: transcript_text of results stored before 00064
	go a.Bots.Run(ctx)                      // bot webhook deliveries
	go a.BoardWebhooks.Run(ctx)
	go a.Birthdays.Run(ctx, time.Hour)
	go a.Achievements.RunLegacyMigration(ctx) // one-shot: pictures of migration 00063
	go a.Calls.Run(ctx)
	go a.Push.Run(ctx)
	go a.Calendar.Run(ctx, calendar.Tick)
	go a.CalDAV.Run(ctx)
	go a.Boards.Run(ctx, a.redis, boards.SweepInterval)
	go a.Boards.RunRules(ctx, a.redis)                                 // scheduled automation rules (ADR-0060)
	go a.Boards.RunApprovalNotices(ctx, boards.ApprovalNoticeInterval) // delayed approval notices (ADR-0082)
	go a.Rooms.RunTempRooms(ctx, a.redis, a.tempRetention)
	go a.SIP.Run(ctx)
	go a.billing.Run(ctx) // returns at once while BILLING_ENABLED=false
	if a.OAuth != nil {
		go a.OAuth.Run(ctx, a.redis, oauthprovider.SweepInterval) // provider retention
	}
}

// RunAfterListen starts the background work that needs the HTTP listener already serving
// (Tochka webhook registration: the bank sends a test webhook to our URL).
func (a *App) RunAfterListen(ctx context.Context) {
	a.billing.RunAfterListen(ctx)
}

// mailSender: the test override, else SMTP from config, else nil (mail disabled).
func mailSender(d Deps) (mail.Sender, error) {
	if d.Mail != nil {
		return d.Mail, nil
	}
	c := d.Config
	if !c.MailEnabled() {
		return nil, nil
	}
	return mail.NewSMTP(c.SMTPHost, c.SMTPPort, c.SMTPUser, c.SMTPPassword, c.SMTPTLS, c.SMTPFrom)
}

func unfurlPolicy(d Deps) func(netip.Addr) bool {
	if d.UnfurlAllowAddr != nil {
		return d.UnfurlAllowAddr
	}
	if len(d.Config.UnfurlAllowCIDRs) > 0 {
		return unfurl.PublicOrAllowed(d.Config.UnfurlAllowCIDRs)
	}
	return nil // unfurl.PublicAddr
}

// New builds the router. Next stages (gateway, messages, files, rtc) register their
// routes here the same way. The config must be valid (config.Load / Validate): invalid
// PLAN_*_LIMITS panic here.
func New(d Deps) *App {
	superadmin.Configure(d.Config.SuperadminEmails)
	redisx.SetKeyPrefix(d.Config.RedisKeyPrefix) // before any key or channel name is built
	free, team, biz, err := plans.Defaults(d.Config.PlanFreeLimits, d.Config.PlanTeamLimits, d.Config.PlanBusinessLimits)
	if err != nil {
		panic(err) // validated by config.Validate
	}
	planSvc := plans.New(d.DB, d.Redis, free, team, biz)
	planSvc.SetBilling(plans.Billing{Seats: d.Seats, Enabled: d.Config.Billing.Enabled,
		Enforced: d.Config.Billing.Enabled && d.Config.Billing.EnforcementEnabled})
	base := d.Events
	if base == nil {
		base = events.Redis{C: d.Redis}
	}
	// Voice: the rtc service reacts to permission/membership/session events it publishes
	// through SyncPublisher; everything else publishes through the same decorated publisher.
	var rtcSvc *rtc.Service
	pushSvc := push.New(d.DB, d.Push)
	pushSvc.Avatars = push.NewAvatars(d.Blob)
	base = push.Publisher{Publisher: base, S: pushSvc}
	pub := base
	if d.Config.LiveKitEnabled() {
		lk := d.LiveKit
		if lk == nil {
			lk = rtc.NewLiveKit(d.Config.LiveKitInternalURL, d.Config.LiveKitAPIKey, d.Config.LiveKitAPISecret)
		}
		rtcSvc = rtc.NewService(rtc.Config{
			PublicURL: d.Config.LiveKitURL, APIKey: d.Config.LiveKitAPIKey, Secret: d.Config.LiveKitAPISecret,
			MaxParticipants: d.Config.LiveKitMaxParticipants,
		}, d.DB, d.Redis, lk, base)
		rtcSvc.Plans = planSvc
		pub = rtc.SyncPublisher{Publisher: base, S: rtcSvc}
	}

	// Bot webhooks (ADR-0031): events bots would get from the gateway are also queued for
	// bots with a webhook. The service gets its own publisher once it is decorated.
	whOpts := d.BotWebhooks
	if whOpts.AllowAddr == nil {
		whOpts.AllowAddr = unfurlPolicy(d)
	}
	botSvc := bots.New(d.DB, d.Redis, nil, planSvc, []byte(d.Config.JWTSecret), whOpts)
	pub = bots.Publisher{Publisher: pub, S: botSvc}
	botSvc.SetEvents(pub)

	sender, err := mailSender(d)
	if err != nil {
		panic(err) // config.Validate checks the SMTP settings first
	}
	mailSvc := mail.New(mail.Config{
		PerAddressPerHour: d.Config.MailPerAddressPerHour, EventsPerAddressPerHour: d.Config.MailEventsPerAddressPerHour,
		PerHour: d.Config.MailPerHour, Secret: []byte(d.Config.JWTSecret),
	}, d.DB, d.Redis, sender)

	billingRT := newBilling(d, planSvc, pub, mailSvc) // ADR-0080 v5: billingwiring.go
	authSvc := auth.NewService(d.Config, d.DB, d.Redis, pub)
	pushSvc.Auth = authSvc
	pushSvc.DeviceLimit = redisx.NewRateLimiter(d.Redis, "rl:push-device:", 20, 20)   // 20 at once, 20 per minute
	pushSvc.ResolveLimit = redisx.NewRateLimiter(d.Redis, "rl:push-resolve:", 60, 60) // notification taps: one per second
	authSvc.OnSessionsRevoked = pushSvc.CleanupSessions
	authSvc.CheckSeat = func(ctx context.Context, q *sqlc.Queries, wsID uuid.UUID) error {
		return planSvc.Check(ctx, q, wsID, plans.KindMembers, true)
	}
	authSvc.AdmitSeat = func(ctx context.Context, q *sqlc.Queries, wsID, userID uuid.UUID, role string) error {
		return planSvc.AdmitSeat(ctx, q, wsID, userID, userID, role)
	}
	authSvc.Mail = mailSvc
	botSvc.SetAuth(authSvc)
	botPerSec, botMsgsPerMin := d.Config.BotLimits()
	authSvc.BotLimiter = redisx.NewRateLimiter(d.Redis, "rl:bot:req:", botPerSec, float64(botPerSec*60))
	authSvc.OnEmailVerified = func(ctx context.Context, u sqlc.User) []uuid.UUID {
		return workspaces.AcceptEmailInvites(ctx, d.DB, planSvc, pub, u)
	}
	if rtcSvc != nil {
		rtcSvc.Revoked = authSvc.IsRevoked
		gate := rtcIdentityGate{db: d.DB, auth: authSvc}
		rtcSvc.IdentityAccess = func(ctx context.Context, ws, room, user, session uuid.UUID) error {
			return gate.check(ctx, ws, room, []rtc.IdentityKey{{User: user, Session: session}})[0]
		}
		rtcSvc.IdentityAccessRoom = gate.check
	}
	var egress rtc.Egress
	if rtcSvc != nil {
		if egress = d.Egress; egress == nil {
			egress = rtc.NewEgress(d.Config.LiveKitInternalURL, d.Config.LiveKitAPIKey, d.Config.LiveKitAPISecret)
		}
	}
	recCfg := recording.Config{
		Dir: d.Config.RecordingsPath, EgressDir: d.Config.RecordingEgressDir,
		MaxConcurrent: d.Config.RecordingMaxConcurrent, Secret: []byte(d.Config.JWTSecret), WebURL: d.Config.GPTunnelWebURL,
	}
	if bc := BlobConfig(d.Config); bc.Driver == blob.DriverS3 {
		// The API and the egress may share no disk: the egress uploads into the files bucket.
		recCfg.Bucket = &recording.Bucket{Store: d.Blob, S3: bc.S3}
	}
	recSvc := recording.New(recCfg, d.DB, d.Redis, egress, gptunnel.New(d.Config.GPTunnelAPIURL), pub)
	recSvc.KeepAudio = time.Duration(d.Config.RecordingKeepDays) * 24 * time.Hour
	recSvc.PlanInactive = func(ctx context.Context, ws uuid.UUID) bool {
		l, err := planSvc.Lapsed(ctx, ws)
		return err == nil && l
	}
	billingRT.onLapsed = recSvc.StopPlanInactive // the restricted mode ends a running meeting recording
	if rtcSvc != nil {
		rtcSvc.OnEgress = recSvc.HandleEgress
	}
	authLimiter := redisx.NewRateLimiter(d.Redis, "rl:auth:", d.Config.AuthRateBurst, d.Config.AuthRatePerMinute)
	accountLimiter := redisx.NewRateLimiter(d.Redis, "rl:login-acct:", d.Config.LoginAccountBurst, float64(d.Config.LoginAccountBurst)/15) // N per 15 min
	msgLimiter := redisx.NewRateLimiter(d.Redis, "rl:msg:", 5, 60)                                                                         // 5 per 5 s per room and user
	filesSvc := files.NewService(d.DB, d.Blob, pub, d.Config.MaxFileSizeMB<<20, d.Config.StorageMaxTotalBytes)
	filesSvc.SetLimiter(redisx.NewRateLimiter(d.Redis, "rl:upload:", 30, 2)) // 30 at once, 120 per hour
	filesSvc.SetPlans(planSvc)
	filesSvc.SetPersonalQuota(d.Config.DefaultPersonalQuotaBytes)
	filesSvc.SetConverter(files.NewConverter(context.Background(), d.Config.FFmpegPath, d.Config.FFprobePath))
	botSvc.SetAvatars(filesSvc)
	recSvc.SetFiles(filesSvc)
	hub := gateway.New(gateway.Config{
		HeartbeatInterval:  d.Config.HeartbeatInterval,
		MaxSessionsPerUser: d.Config.MaxDevicesPerUser,
		ShutdownSpread:     5 * time.Second,
		AllowedOrigins:     d.Config.AllowedOrigins(),
		Plans:              planSvc,
		PlanContact:        d.Config.PlanContact(),
		BillingSelfServe:   d.Config.Billing.Enabled && d.Config.Billing.SelfServe,
	}, d.DB, d.Redis, authSvc, pub)

	authSvc.OnBotRequest = hub.TouchBot

	// One-to-one calls (ADR-0034): signalling here, media through rtc (DM voice sessions).
	callSvc := calls.New(d.DB, d.Redis, pub,
		redisx.NewRateLimiter(d.Redis, "rl:call:", 10, 10),  // 10 at once, 10 per minute
		redisx.NewRateLimiter(d.Redis, "rl:call:dm:", 3, 2)) // per DM: 3 at once, then one per 30 s
	callSvc.Presence = hub.PresenceChanged
	pushSvc.Calls = callSvc.Store()
	if rtcSvc != nil {
		rtcSvc.Calls = callSvc
		callSvc.Media = rtcSvc
	}

	// Authenticated API routes: identity + the bot route table (ADR-0031) + fresh per-request
	// permission resolver + the suspension guard (write routes of suspended workspaces,
	// item 32).
	guard := moderation.Guard(d.DB.Q, func(ctx context.Context) uuid.UUID { return auth.MustFromContext(ctx).UserID })
	if rtcSvc != nil {
		hub.IdentityInvalidated = rtcSvc.IdentityChanged
	}
	private := func(h http.Handler) http.Handler {
		g := identityGate(d.DB.Q, authSvc, planSvc.CheckActive, guard(h))
		return authSvc.Require(botGate(d.DB.Q, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			g.ServeHTTP(w, r.WithContext(perm.WithResolver(r.Context(), d.DB.Q)))
		})))
	}

	previews := redisx.NewRateLimiter(d.Redis, "rl:invite-preview:", 30, 30) // 30 per minute per IP, before policy/unknown-code rejection
	mux := &routeRecorder{ServeMux: http.NewServeMux(), capability: publicIdentityGate(d.DB.Q, previews)}
	health.Routes(mux, d.DB.Pool, d.Redis)
	buildinfo.Routes(mux, d.Config.PlanContact())
	mux.Handle("GET /metrics", promhttp.Handler())
	mux.Handle("GET /gateway", hub)

	ah := auth.NewHandlers(authSvc, authLimiter, accountLimiter, d.Config.AllowedOrigins())
	ah.IdentityOrigin = d.Config.IdentityPublicOrigin
	rp, ds, op := wireIdentity(d, mux, authSvc, planSvc.CheckActive)
	ah.Public(mux)
	ah.Private(mux, private)
	pushSvc.Routes(mux, private)
	userHandlers := users.NewHandlers(d.DB, pub, hub)
	userHandlers.UsernameLimit = redisx.NewRateLimiter(d.Redis, "rl:username-check:", 30, 30) // ADR-0077: 30 at once, then one per 2 s
	userHandlers.Routes(mux, private)
	workspaces.NewHandlers(d.DB, pub, d.Blob, workspaces.Limits{
		MaxOwned:      d.Config.MaxWorkspacesPerUser,
		Quota:         d.Config.DefaultWorkspaceQuotaBytes,
		CreateLimiter: redisx.NewRateLimiter(d.Redis, "rl:ws-create:", d.Config.WorkspaceCreatesPerHour, float64(d.Config.WorkspaceCreatesPerHour)/60),
		Plans:         planSvc,
		// Public identity wrapper charges preview requests exactly once.
	}).WithEmailInvites(workspaces.EmailInvites{
		Mail: mailSvc, PublicURL: d.Config.PublicAppURL,
		Lookup: redisx.NewRateLimiter(d.Redis, "rl:invite-lookup:", 20, 20), // 20 per minute
		Send:   redisx.NewRateLimiter(d.Redis, "rl:invite-send:", 20, 0.5),  // 20 at once, 30 per hour
	}).WithFiles(filesSvc).WithVoice(voice.Store{C: d.Redis}.Rooms).WithEmailGate(authSvc.EmailGate()).Routes(mux, private)
	roomHandlers := rooms.NewHandlers(d.DB, pub).WithPlans(planSvc)
	roomHandlers.PublicURL = d.Config.PublicAppURL
	roomHandlers.EmailGate = authSvc.EmailGate()
	roomHandlers.Routes(mux, private)
	roomHandlers.CategoryRoutes(mux, private)
	msgHandlers := messages.NewHandlers(d.DB, pub, msgLimiter)
	msgHandlers.BotLimiter = redisx.NewRateLimiter(d.Redis, "rl:bot:msg:", botMsgsPerMin, float64(botMsgsPerMin))
	msgHandlers.Receipts = messages.NewReceipts(d.DB, pub, d.Redis)
	boardSvc := boards.New(d.DB, pub, planSvc, filesSvc)
	boardSvc.PublicURL = d.Config.PublicAppURL
	boardSvc.FormReadLimit = redisx.NewRateLimiter(d.Redis, "rl:form-read:", 30, 30)
	boardSvc.FormIPLimit = redisx.NewRateLimiter(d.Redis, "rl:form-ip:", 5, 5)
	boardSvc.FormUserLimit = redisx.NewRateLimiter(d.Redis, "rl:form-user:", 10, 10)
	boardSvc.FormSubmitLimit = redisx.NewRateLimiter(d.Redis, "rl:form-submit:", 30, 30)
	boardSvc.CreateLimit = redisx.NewRateLimiter(d.Redis, "rl:task-create:", 60, 60) // 60 at once, one per second
	boardSvc.SearchLimit = redisx.NewRateLimiter(d.Redis, "rl:task-search:", 30, 60) // ⌘K: 30 at once, one per second
	msgHandlers.TaskHook = boardSvc.TaskHook
	msgHandlers.TaskCommentHook = boardSvc.TaskCommentHook
	boardHooks := boardSvc.EnableWebhooks(d.Redis, []byte(d.Config.JWTSecret), whOpts) // same delivery options as bots
	boardSvc.EnableGit(d.Redis, []byte(d.Config.JWTSecret))                            // repository webhooks of boards (ADR-0060)
	msgHandlers.Routes(mux, private)
	boardSvc.Routes(mux, private)
	searchSvc := search.New(d.DB)
	searchSvc.Limit = redisx.NewRateLimiter(d.Redis, "rl:search:", 30, 60) // unified search (ADR-0062): 30 at once, one per second
	searchSvc.Routes(mux, private)
	dmHandlers := dms.NewHandlers(d.DB, pub, redisx.NewRateLimiter(d.Redis, "rl:dm-create:", 10, 0.5)) // 10 at once, 30 per hour
	dmHandlers.EmailGate = authSvc.EmailGate()
	dmHandlers.Routes(mux, private)
	notes.NewHandlers(d.DB, pub, d.Config.DefaultPersonalQuotaBytes).Routes(mux, private)
	filesSvc.Routes(mux, private)
	stickers.NewHandlers(d.DB, pub, filesSvc, planSvc,
		redisx.NewRateLimiter(d.Redis, "rl:sticker-upload:", 10, 1)).Routes(mux, private) // 10 batches at once, 60 per hour
	sounds.NewHandlers(d.DB, pub, filesSvc, voice.Store{C: d.Redis}).Routes(mux, private)
	guestSvc := guests.NewService(d.DB, authSvc, pub, d.Blob,
		redisx.NewRateLimiter(d.Redis, "rl:guest:", 5, 5.0/60), d.Config.AllowedOrigins()) // 5 guests/h per IP
	guestSvc.Plans = planSvc
	guestSvc.Routes(mux, private)
	admin := plans.NewAdmin(d.DB, planSvc, pub, redisx.NewRateLimiter(d.Redis, "rl:admin:", 60, 60)) // 60 per minute
	admin.StorageQuota = func(ctx context.Context, q *sqlc.Queries, userID uuid.UUID) (*v1.UserStorageQuota, error) {
		qt, err := notes.PersonalQuota(ctx, q, userID, d.Config.DefaultPersonalQuotaBytes)
		return qt.Proto(), err
	}
	admin.Routes(mux, private)
	// Balance billing (ADR-0080 v5): every route registered; 501 while BILLING_ENABLED=false.
	billingRT.Routes(mux, private)
	achSvc := achievements.New(d.DB, d.Blob, filesSvc, pub, voice.Store{C: d.Redis}.Rooms)
	achSvc.Plans = planSvc
	achSvc.Routes(mux, private)
	unfurlSvc := unfurl.NewService(d.Redis, []byte(d.Config.JWTSecret),
		redisx.NewRateLimiter(d.Redis, "rl:unfurl:", 30, 120), unfurl.Options{AllowAddr: unfurlPolicy(d)})
	unfurlSvc.Internal = boardSvc.Unfurl(d.Config.AllowedOrigins()) // own /t/ and /b/ links (ADR-0042)
	unfurlSvc.Routes(mux, private)
	recSvc.Routes(mux, private)
	botSvc.Routes(mux, private)
	bdSvc := birthdays.New(d.DB, pub)
	bdSvc.Routes(mux, private)
	callSvc.Routes(mux, private)
	calSvc := calendar.New(calendar.Config{PublicURL: d.Config.PublicAppURL, Secret: []byte(d.Config.JWTSecret), MailFrom: d.Config.SMTPFrom},
		d.DB, pub, mailSvc,
		redisx.NewRateLimiter(d.Redis, "rl:event-write:", 30, 2), // 30 at once, 120 per hour
		redisx.NewRateLimiter(d.Redis, "rl:event-rsvp:", 30, 30)) // signed answer links: 30 per minute per IP
	calSvc.Presence = hub.Statuses
	calSvc.EmailGate = authSvc.EmailGate()
	// CalDAV push and meeting mails leave Calab without a request: the workspace identity
	// policy decides per user (ADR-0054).
	calSvc.Identity = &identitypolicy.Delivery{Loader: identitypolicy.NewSQLLoader(d.DB.Q, d.Config.IdentityEntitlements())}
	recSvc.OnStarted = calSvc.RecordingStarted
	calSvc.FreeBusyLimit = redisx.NewRateLimiter(d.Redis, "rl:freebusy:", 60, 60) // ADR-0041 §5: 60 per minute
	calSvc.SuggestLimit = redisx.NewRateLimiter(d.Redis, "rl:suggest:", 30, 30)   // 30 per minute
	calSvc.Routes(mux, private)
	roomHandlers.Meetings = calSvc // temporary rooms book and close meetings (ADR-0044)
	cdOpts := d.CalDAV
	if cdOpts.AllowAddr == nil {
		cdOpts.AllowAddr = unfurlPolicy(d)
	}
	if cdOpts.SyncInterval == 0 {
		cdOpts.SyncInterval = d.Config.CalDAVSyncInterval
	}
	cdSvc := caldav.New(d.DB, d.Redis, calSvc, []byte(d.Config.JWTSecret), cdOpts,
		redisx.NewRateLimiter(d.Redis, "rl:caldav-connect:", 5, 5.0/60), // 5 per hour
		redisx.NewRateLimiter(d.Redis, "rl:caldav-sync:", 1, 1))         // once per minute
	cdSvc.DeleteLimit = redisx.NewRateLimiter(d.Redis, "rl:caldav-delete:", 30, 30) // ADR-0045 amendment 1: 30 per minute
	calSvc.Changed = cdSvc.EventChanged
	calSvc.ExternalReminders = cdSvc.DueReminders                                        // ADR-0045 amendment 3: one sweep, one EVENT_REMINDER
	cdSvc.AllowsCalDAV, calSvc.AllowsCalDAV = planSvc.AllowsCalDAV, planSvc.AllowsCalDAV // Free has no CalDAV (ADR-0024)
	cdSvc.Routes(mux, private)
	// Telephony (ADR-0046): phone lines join rooms through the LiveKit SIP API.
	var lkSIP rtc.SIP
	var lkRooms rtc.LiveKit
	if rtcSvc != nil {
		if lkSIP = d.SIP; lkSIP == nil {
			lkSIP = rtc.NewSIP(d.Config.LiveKitInternalURL, d.Config.LiveKitAPIKey, d.Config.LiveKitAPISecret)
		}
		if lkRooms = d.LiveKit; lkRooms == nil {
			lkRooms = rtc.NewLiveKit(d.Config.LiveKitInternalURL, d.Config.LiveKitAPIKey, d.Config.LiveKitAPISecret)
		}
	}
	sipOpts := d.SIPOptions
	if sipOpts.AllowAddr == nil {
		sipOpts.AllowAddr = unfurlPolicy(d)
	}
	sipSvc := sip.New(d.DB, d.Redis, lkRooms, lkSIP, pub, planSvc, []byte(d.Config.JWTSecret), sipOpts)
	sipSvc.Routes(mux, private)
	if rtcSvc != nil {
		rtcSvc.SIP = sipSvc
		rtcSvc.Routes(mux, private)
	} else {
		rtc.DisabledRoutes(mux, private)
	}
	mux.Handle("/api/", httpx.HandlerFunc(func(http.ResponseWriter, *http.Request) error {
		return httpx.NotFound("route")
	}))

	h := httpx.Chain(mux.ServeMux,
		httpx.WithRequestID,
		httpx.WithClientIP(d.Config.TrustedProxies),
		httpx.APIHeaders,
		httpx.Observe,
		httpx.Recover,
		events.Middleware, // one post-commit publish budget per request
	)
	return &App{SSO: rp, Directory: ds, OAuth: op, Handler: h, Auth: authSvc, Gateway: hub, Files: filesSvc, Guests: guestSvc, RTC: rtcSvc, Plans: planSvc, Mail: mailSvc,
		Recording: recSvc, Search: searchSvc, Bots: botSvc, Birthdays: bdSvc, Achievements: achSvc, Calls: callSvc, Push: pushSvc, Calendar: calSvc, CalDAV: cdSvc, Boards: boardSvc, BoardWebhooks: boardHooks, Rooms: roomHandlers, SIP: sipSvc, billing: billingRT, redis: d.Redis, identityDB: d.DB, Routes: mux.patterns,
		tempRetention: time.Duration(d.Config.TempRoomRetentionDays) * 24 * time.Hour}
}

// SetBilling switches billing admission and enforcement at run time (tests; the startup values
// come from BILLING_ENABLED / BILLING_ENFORCEMENT_ENABLED and Deps.Seats): the paid-seat hook,
// Workspace.billing and the billing suspension of every identity gate of this instance.
func (a *App) SetBilling(seats billing.Seats, enabled, enforced bool) {
	a.Plans.SetBilling(plans.Billing{Seats: seats, Enabled: enabled, Enforced: enabled && enforced})
	a.Auth.SetBillingEnforcement(enabled && enforced)
}
