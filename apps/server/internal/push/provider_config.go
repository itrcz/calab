package push

import (
	"crypto/elliptic"
	"encoding/json"
	"errors"
	"io"
	"net/mail"
	"os"
	"regexp"
	"strings"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/config"
	"github.com/golang-jwt/jwt/v5"
)

var applicationID = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+$`)
var appleID = regexp.MustCompile(`^[A-Z0-9]{10}$`)
var projectID = regexp.MustCompile(`^[a-z][a-z0-9-]{4,28}[a-z0-9]$`)

func keyFile(path string) ([]byte, error) {
	// The operator supplies this path through server environment, never a request
	// or push payload. Credentials may deliberately live outside the checkout.
	file, err := os.Open(path) // #nosec G304 -- operator-owned local credential file
	if err != nil {
		return nil, errors.New("push credential file unavailable")
	}
	defer func() { _ = file.Close() }()
	data, err := io.ReadAll(io.LimitReader(file, 65537))
	if err != nil || len(data) > 65536 {
		return nil, errors.New("push credential file invalid")
	}
	return data, nil
}
func complete(values ...string) (bool, error) {
	count := 0
	for _, value := range values {
		if value != "" {
			count++
		}
	}
	if count == 0 {
		return false, nil
	}
	if count != len(values) {
		return false, errors.New("push provider configuration incomplete")
	}
	return true, nil
}

// NewProviders validates local credentials without contacting a provider. Omitted
// transports stay absent; hosts and OAuth audience cannot be selected by payload.
func NewProviders(c *config.Config) (map[v1.PushProvider]Provider, error) {
	providers := map[v1.PushProvider]Provider{}
	apns, err := complete(c.PushAPNSKeyFile, c.PushAPNSKeyID, c.PushAPNSTeamID, c.PushAPNSAppID)
	if err != nil {
		return nil, err
	}
	if apns {
		environment := c.PushAPNSEnvironment
		if environment == "" {
			environment = "production"
		}
		if !applicationID.MatchString(c.PushAPNSAppID) || len(c.PushAPNSAppID) > 255 || !appleID.MatchString(c.PushAPNSKeyID) || !appleID.MatchString(c.PushAPNSTeamID) || (environment != "production" && environment != "development") {
			return nil, errors.New("push APNs application configuration invalid")
		}
		pem, err := keyFile(c.PushAPNSKeyFile)
		if err != nil {
			return nil, err
		}
		key, err := jwt.ParseECPrivateKeyFromPEM(pem)
		if err != nil || key.Curve != elliptic.P256() {
			return nil, errors.New("push APNs requires an ES256 private key")
		}
		sender := &apnsSender{key: key, team: c.PushAPNSTeamID, keyID: c.PushAPNSKeyID, app: c.PushAPNSAppID, environment: environment, client: providerHTTP()}
		providers[v1.PushProvider_PUSH_PROVIDER_APNS] = Provider{AppID: c.PushAPNSAppID, Environment: environment, Sender: sender}
		if c.PushVoIPEnabled {
			providers[v1.PushProvider_PUSH_PROVIDER_VOIP] = Provider{AppID: c.PushAPNSAppID, Environment: environment, Sender: sender}
		}
	}
	fcm, err := complete(c.PushFCMServiceAccountFile, c.PushFCMProjectID, c.PushFCMAppID)
	if err != nil {
		return nil, err
	}
	if fcm {
		if !applicationID.MatchString(c.PushFCMAppID) || len(c.PushFCMAppID) > 255 || !projectID.MatchString(c.PushFCMProjectID) {
			return nil, errors.New("push FCM application configuration invalid")
		}
		data, err := keyFile(c.PushFCMServiceAccountFile)
		if err != nil {
			return nil, err
		}
		var credentials struct {
			Type     string `json:"type"`
			Project  string `json:"project_id"`
			Email    string `json:"client_email"`
			Key      string `json:"private_key"`
			TokenURI string `json:"token_uri"`
		}
		if err = json.Unmarshal(data, &credentials); err != nil || credentials.Type != "service_account" || credentials.Project != c.PushFCMProjectID || (credentials.TokenURI != "" && credentials.TokenURI != oauthEndpoint) {
			return nil, errors.New("push FCM service account configuration invalid")
		}
		address, err := mail.ParseAddress(credentials.Email)
		if err != nil || address.Address != credentials.Email || !strings.HasSuffix(credentials.Email, ".gserviceaccount.com") {
			return nil, errors.New("push FCM service account identity invalid")
		}
		key, err := jwt.ParseRSAPrivateKeyFromPEM([]byte(credentials.Key))
		if err != nil || key.N.BitLen() < 2048 {
			return nil, errors.New("push FCM requires an RSA private key")
		}
		providers[v1.PushProvider_PUSH_PROVIDER_FCM] = Provider{AppID: c.PushFCMAppID, Environment: "production", Sender: &fcmSender{key: key, email: credentials.Email, project: c.PushFCMProjectID, app: c.PushFCMAppID, client: providerHTTP()}}
	}
	return providers, nil
}
