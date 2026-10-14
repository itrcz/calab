package tochkapay

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"strings"
)

// ParseSigningKey reads our RSA private key (PEM, PKCS#1 «RSA PRIVATE KEY» or PKCS#8 «PRIVATE
// KEY», ≥ 2048 bits; a base64 of the PEM on one line is accepted too, for env files). The bank
// requires RSA 2048 and checks the Signature header of create payment / capture / refund.
func ParseSigningKey(spec string) (*rsa.PrivateKey, error) {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return nil, fmt.Errorf("%w: TOCHKA_PAY_SIGNING_KEY is empty", ErrInvalidRequest)
	}
	if !strings.HasPrefix(spec, "-----BEGIN") {
		b, err := base64.StdEncoding.DecodeString(spec)
		if err != nil {
			return nil, fmt.Errorf("%w: TOCHKA_PAY_SIGNING_KEY is neither PEM nor base64 of PEM", ErrInvalidRequest)
		}
		spec = string(b)
	}
	block, _ := pem.Decode([]byte(strings.ReplaceAll(spec, `\n`, "\n")))
	if block == nil {
		return nil, fmt.Errorf("%w: TOCHKA_PAY_SIGNING_KEY is not PEM", ErrInvalidRequest)
	}
	var key *rsa.PrivateKey
	switch block.Type {
	case "RSA PRIVATE KEY":
		k, err := x509.ParsePKCS1PrivateKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("%w: TOCHKA_PAY_SIGNING_KEY: PKCS#1: %w", ErrInvalidRequest, err)
		}
		key = k
	case "PRIVATE KEY":
		k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("%w: TOCHKA_PAY_SIGNING_KEY: PKCS#8: %w", ErrInvalidRequest, err)
		}
		rk, ok := k.(*rsa.PrivateKey)
		if !ok {
			return nil, fmt.Errorf("%w: TOCHKA_PAY_SIGNING_KEY must be an RSA key", ErrInvalidRequest)
		}
		key = rk
	default:
		return nil, fmt.Errorf("%w: TOCHKA_PAY_SIGNING_KEY: PEM block %q is not a private key", ErrInvalidRequest, block.Type)
	}
	if key.N.BitLen() < 2048 {
		return nil, fmt.Errorf("%w: TOCHKA_PAY_SIGNING_KEY must be at least 2048 bits", ErrInvalidRequest)
	}
	return key, nil
}

// sign is the Signature header of a request body: RSASSA-PKCS1-v1_5 over SHA-256 of the exact
// bytes sent, base64 on one line (`openssl dgst -sha256 -sign key | openssl base64 -A`).
func sign(key *rsa.PrivateKey, body []byte) (string, error) {
	sum := sha256.Sum256(body)
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		return "", fmt.Errorf("tochkapay: sign: %w", err)
	}
	return base64.StdEncoding.EncodeToString(sig), nil
}

// Verify checks a Signature header against a public key (the fake bank of tests and the
// operator's self-check use it).
func Verify(pub *rsa.PublicKey, body []byte, signature string) error {
	sig, err := base64.StdEncoding.DecodeString(signature)
	if err != nil {
		return fmt.Errorf("tochkapay: signature is not base64: %w", err)
	}
	sum := sha256.Sum256(body)
	return rsa.VerifyPKCS1v15(pub, crypto.SHA256, sum[:], sig)
}

// PublicKeyBase64 is what the bank asks for at onboarding: the public half as PEM («PUBLIC
// KEY», PKIX), base64 on one line (`openssl rsa -pubout | openssl base64 -A`).
func PublicKeyBase64(key *rsa.PrivateKey) (string, error) {
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})), nil
}
