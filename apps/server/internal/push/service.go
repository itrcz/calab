// Package push owns optional, session-bound native routing endpoints and bounded delivery.
package push

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/calls"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/google/uuid"
)

// Payload carries opaque routing references without contents, credentials or origins.
type Payload struct {
	Version     int    `json:"v"`
	Binding     string `json:"binding"`
	EventID     string `json:"eventId"`
	Kind        string `json:"kind"`
	ReferenceID string `json:"-"`
	RoomID      string `json:"-"`
	ExpiresAt   int64  `json:"expiresAt"`
	Silent      bool   `json:"silent,omitempty"`
}

// Endpoint is the server-authorized transport destination for one registry version.
type Endpoint struct {
	Token, AppID, Environment string
	Provider                  v1.PushProvider
}

// Result deliberately contains no raw response, token, origin or provider credential.
type Result struct {
	Retry, Invalid bool
	RetryAfter     time.Duration
	InvalidBefore  *time.Time
}

// Sender performs one bounded provider attempt and returns sanitized classification.
type Sender interface {
	Send(context.Context, Endpoint, Payload) Result
}

// Provider fixes the application and environment a configured transport may serve.
type Provider struct {
	AppID, Environment string
	Sender             Sender
}

// CallStore supplies the current authoritative call for send-time and resolve-time policy.
type CallStore interface {
	Current(context.Context, uuid.UUID) (calls.Record, bool, error)
}

// Service owns session-bound endpoints and durable authorized routing/delivery.
type Service struct {
	Auth      *auth.Service
	Calls     CallStore
	db        *db.DB
	providers map[v1.PushProvider]Provider
}

// New copies configured providers; no sender means no routing or delivery.
func New(d *db.DB, providers map[v1.PushProvider]Provider) *Service {
	copyProviders := make(map[v1.PushProvider]Provider, len(providers))
	for kind, provider := range providers {
		if provider.Sender != nil && (kind == v1.PushProvider_PUSH_PROVIDER_APNS || kind == v1.PushProvider_PUSH_PROVIDER_VOIP || kind == v1.PushProvider_PUSH_PROVIDER_FCM) {
			copyProviders[kind] = provider
		}
	}
	return &Service{db: d, providers: copyProviders}
}

type routeMux interface{ Handle(string, http.Handler) }

// Routes exposes authenticated capabilities and current-session registry mutations.
func (s *Service) Routes(mux routeMux, private func(http.Handler) http.Handler) {
	mux.Handle("GET /api/me/push-capabilities", private(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		identity := auth.MustFromContext(r.Context())
		if _, err := db.GuardValue(r.Context(), s.db, func(q *sqlc.Queries) (sqlc.Session, error) {
			return q.LockPushSession(r.Context(), sqlc.LockPushSessionParams{ID: identity.SessionID, UserID: identity.UserID})
		}); err != nil {
			httpx.WriteError(w, r, httpx.Unauthenticated("session unavailable"))
			return
		}
		capabilities := &v1.PushCapabilitiesResponse{}
		for _, kind := range []v1.PushProvider{v1.PushProvider_PUSH_PROVIDER_APNS, v1.PushProvider_PUSH_PROVIDER_VOIP, v1.PushProvider_PUSH_PROVIDER_FCM} {
			if provider, ok := s.providers[kind]; ok {
				capabilities.Providers = append(capabilities.Providers, &v1.PushCapability{Provider: kind, Environment: provider.Environment, AppId: provider.AppID})
			}
		}
		httpx.Write(w, http.StatusOK, capabilities)
	})))
	mux.Handle("POST /api/me/push-devices", private(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request v1.RegisterPushDeviceRequest
		if err := httpx.Decode(w, r, &request); err != nil {
			httpx.WriteError(w, r, err)
			return
		}
		result, err := s.Register(r.Context(), auth.MustFromContext(r.Context()), &request)
		if err != nil {
			httpx.WriteError(w, r, err)
			return
		}
		httpx.Write(w, http.StatusOK, result)
	})))
	mux.Handle("DELETE /api/me/push-devices/{id}", private(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, err := uuid.Parse(r.PathValue("id"))
		if err != nil {
			httpx.WriteError(w, r, httpx.BadRequest("invalid device"))
			return
		}
		var request v1.UnregisterPushDeviceRequest
		if err := httpx.Decode(w, r, &request); err != nil {
			httpx.WriteError(w, r, err)
			return
		}
		if request.Version == 0 || request.Version > 1<<63-1 {
			httpx.WriteError(w, r, httpx.BadRequest("invalid version"))
			return
		}
		version := int64(request.Version)
		identity := auth.MustFromContext(r.Context())
		rows, err := db.GuardValue(r.Context(), s.db, func(q *sqlc.Queries) (int64, error) {
			return q.DeletePushDeviceOwned(r.Context(), sqlc.DeletePushDeviceOwnedParams{ID: id, UserID: identity.UserID, SessionID: identity.SessionID, Version: version})
		})
		if err != nil {
			httpx.WriteError(w, r, err)
			return
		}
		if rows == 0 {
			httpx.WriteError(w, r, httpx.NotFound("device"))
			return
		}
		httpx.NoContent(w)
	})))
	mux.Handle("POST /api/me/push-resolve", private(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request v1.ResolvePushRequest
		if err := httpx.Decode(w, r, &request); err != nil {
			httpx.WriteError(w, r, err)
			return
		}
		event, err := uuid.Parse(request.EventId)
		binding, bindingErr := uuid.Parse(request.Binding)
		if err != nil || bindingErr != nil || event == uuid.Nil || binding == uuid.Nil {
			httpx.WriteError(w, r, httpx.NotFound("notification"))
			return
		}
		identity := auth.MustFromContext(r.Context())
		// Resolution only reads current authority; source locks below follow the
		// canonical workspace-before-session order instead of write admission.
		ctx := s.Auth.WithPolicy(db.WithoutAdmission(r.Context()), identity, identitypolicy.WorkspaceRead)
		var response *v1.ResolvePushResponse
		err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
			job, err := q.GetPushReference(ctx, sqlc.GetPushReferenceParams{ID: event, ID_2: binding, UserID: identity.UserID, SessionID: identity.SessionID})
			if err != nil {
				if db.IsNotFound(err) {
					return httpx.NotFound("notification")
				}
				return err
			}
			session, err := s.lockDeliverySession(ctx, q, identity.UserID, identity.SessionID, job)
			if err != nil {
				return httpx.NotFound("notification")
			}
			user, err := q.GetUser(ctx, identity.UserID)
			if err != nil {
				return err
			}
			allowed, _, err := s.allowed(ctx, q, user, session, job)
			if err != nil {
				return err
			}
			if !allowed || job.RoomID == nil {
				return httpx.NotFound("notification")
			}
			access, err := perm.NewResolver(q).Room(ctx, *job.RoomID, identity.UserID)
			if err != nil {
				return httpx.NotFound("notification")
			}
			workspace := ""
			if access.WorkspaceID != uuid.Nil {
				workspace = access.WorkspaceID.String()
			}
			response = &v1.ResolvePushResponse{RoomId: job.RoomID.String(), WorkspaceId: workspace, MessageId: job.ReferenceID.String()}
			if job.Kind == callKind {
				rec, live, err := s.Calls.Current(ctx, identity.UserID)
				if err != nil {
					return err
				}
				if !live || rec.ID != job.ReferenceID || rec.State != v1.CallState_CALL_STATE_RINGING {
					return httpx.NotFound("call")
				}
				response.MessageId = ""
				response.Call = rec.Proto()
			}
			return nil
		})
		if err != nil {
			httpx.WriteError(w, r, err)
			return
		}
		httpx.Write(w, http.StatusOK, response)
	})))

}

// Register idempotently binds or rotates a token for the current authenticated session.
func (s *Service) Register(ctx context.Context, identity auth.Identity, request *v1.RegisterPushDeviceRequest) (*v1.RegisterPushDeviceResponse, error) {
	if request.CallsEnabled != (request.Provider == v1.PushProvider_PUSH_PROVIDER_VOIP) || (request.Provider == v1.PushProvider_PUSH_PROVIDER_VOIP && request.NotificationsEnabled) {
		return nil, httpx.Validation("callsEnabled", "call push unavailable")
	}
	mentionsEnabled := request.MentionsEnabled == nil || request.GetMentionsEnabled()
	var providerNumber int16
	switch request.Provider {
	case v1.PushProvider_PUSH_PROVIDER_APNS:
		providerNumber = 1
	case v1.PushProvider_PUSH_PROVIDER_VOIP:
		providerNumber = 2
	case v1.PushProvider_PUSH_PROVIDER_FCM:
		providerNumber = 3
	default:
		return nil, httpx.Validation("provider", "unsupported provider")
	}
	provider, ok := s.providers[request.Provider]
	if !ok || provider.AppID != request.AppId || provider.Environment != request.Environment {
		return nil, httpx.Unavailable(nil)
	}
	installation, err := uuid.Parse(request.InstallationId)
	if err != nil || installation == uuid.Nil {
		return nil, httpx.Validation("installationId", "invalid installation")
	}
	token := request.Token
	if request.Provider != v1.PushProvider_PUSH_PROVIDER_FCM {
		token = strings.ToLower(token)
		if _, err := hex.DecodeString(token); err != nil {
			return nil, httpx.Validation("token", "invalid token")
		}
	}
	if len(token) == 0 || len(token) > 4096 || strings.IndexFunc(token, func(r rune) bool { return r <= 32 || r >= 127 }) >= 0 {
		return nil, httpx.Validation("token", "invalid token")
	}
	digest := sha256.Sum256([]byte(token))
	var device sqlc.PushDevice
	err = s.db.Tx(ctx, func(q *sqlc.Queries) error {
		if err := q.LockPushRegistry(ctx); err != nil {
			return err
		}
		if _, err := q.LockPushSession(ctx, sqlc.LockPushSessionParams{ID: identity.SessionID, UserID: identity.UserID}); err != nil {
			if db.IsNotFound(err) {
				return httpx.Unauthenticated("session unavailable")
			}
			return err
		}
		previous, err := q.FindPushEndpoint(ctx, sqlc.FindPushEndpointParams{Provider: providerNumber, Environment: request.Environment, AppID: request.AppId, TokenHash: digest[:]})
		if err != nil && !db.IsNotFound(err) {
			return err
		}
		if err == nil && (previous.SessionID != identity.SessionID || previous.InstallationID != installation) {
			session, err := q.GetSession(ctx, previous.SessionID)
			if err != nil && !db.IsNotFound(err) {
				return err
			}
			if err == nil && session.RevokedAt == nil && session.ExpiresAt.After(time.Now()) {
				return httpx.Conflict("endpoint already registered")
			}
			if _, err := q.DeletePushDeviceVersion(ctx, sqlc.DeletePushDeviceVersionParams{ID: previous.ID, Version: previous.Version, TokenHash: previous.TokenHash}); err != nil {
				return err
			}
		}
		existing, err := q.FindPushInstallation(ctx, sqlc.FindPushInstallationParams{SessionID: identity.SessionID, InstallationID: installation, Provider: providerNumber, Environment: request.Environment, AppID: request.AppId})
		if err == nil {
			if existing.UserID != identity.UserID {
				return httpx.Forbidden("device ownership mismatch")
			}
			if bytes.Equal(existing.TokenHash, digest[:]) && existing.NotificationsEnabled == request.NotificationsEnabled && existing.CallsEnabled == request.CallsEnabled && existing.MentionsEnabled == mentionsEnabled && existing.AllEnabled == request.AllEnabled {
				device, err = q.RefreshPushDevice(ctx, existing.ID)
				return err
			}
			device, err = q.RotatePushDevice(ctx, sqlc.RotatePushDeviceParams{ID: existing.ID, Token: token, TokenHash: digest[:], NotificationsEnabled: request.NotificationsEnabled, CallsEnabled: request.CallsEnabled, MentionsEnabled: mentionsEnabled, AllEnabled: request.AllEnabled})
			if err != nil {
				return err
			}
			return q.DiscardPushRotation(ctx, sqlc.DiscardPushRotationParams{DeviceID: device.ID, DeviceVersion: device.Version})
		}
		if !db.IsNotFound(err) {
			return err
		}
		count, err := q.CountPushDevices(ctx, identity.UserID)
		if err != nil {
			return err
		}
		if count >= 32 {
			return httpx.RateLimited()
		}
		device, err = q.CreatePushDevice(ctx, sqlc.CreatePushDeviceParams{UserID: identity.UserID, SessionID: identity.SessionID, InstallationID: installation, Provider: providerNumber, Environment: request.Environment, AppID: request.AppId, Token: token, TokenHash: digest[:], NotificationsEnabled: request.NotificationsEnabled, CallsEnabled: request.CallsEnabled, MentionsEnabled: mentionsEnabled, AllEnabled: request.AllEnabled})
		return err
	})
	if err != nil {
		return nil, err
	}
	return &v1.RegisterPushDeviceResponse{Id: device.ID.String(), Version: uint64(device.Version)}, nil //nolint:gosec // PostgreSQL CHECK(version > 0).
}

// CleanupSessions removes routing endpoints for every commonly revoked session.
func (s *Service) CleanupSessions(ctx context.Context, sessions []uuid.UUID) error {
	return db.GuardExec(db.WithoutAdmission(ctx), s.db, func(q *sqlc.Queries) error { return q.DeletePushSessions(ctx, sessions) })
}

// Run owns bounded fanout, delivery and expiring storage cleanup until cancellation.
func (s *Service) Run(ctx context.Context) {
	var workers sync.WaitGroup
	if len(s.providers) > 0 {
		for _, step := range []func(context.Context) error{s.Fanout, s.Deliver} {
			workers.Add(1)
			go func(step func(context.Context) error) {
				defer workers.Done()
				ticker := time.NewTicker(time.Second)
				defer ticker.Stop()
				for {
					select {
					case <-ctx.Done():
						return
					case <-ticker.C:
						_ = step(ctx)
					}
				}
			}(step)
		}
	}
	defer workers.Wait()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	lastCleanup := time.Time{}
	for {
		if time.Since(lastCleanup) >= time.Minute && s.cleanup(ctx) {
			lastCleanup = time.Now()
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
func (s *Service) cleanup(ctx context.Context) bool {
	settled := true
	bounded, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	for _, sweep := range []func(context.Context) (int64, error){func(ctx context.Context) (int64, error) {
		return db.GuardValue(ctx, s.db, func(q *sqlc.Queries) (int64, error) { return q.CleanupPushIntents(ctx) })
	},
		func(ctx context.Context) (int64, error) {
			return db.GuardValue(ctx, s.db, func(q *sqlc.Queries) (int64, error) { return q.CleanupPushDeliveries(ctx) })
		},
		func(ctx context.Context) (int64, error) {
			return db.GuardValue(ctx, s.db, func(q *sqlc.Queries) (int64, error) { return q.CleanupPushDevices(ctx) })
		}} {
		for {
			n, err := sweep(bounded)
			if err != nil {
				settled = false
				break
			}
			if n < 500 {
				break
			}
		}
	}
	return settled
}
