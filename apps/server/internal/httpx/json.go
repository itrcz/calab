package httpx

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// MaxJSONBody caps REST request bodies (file uploads use their own path).
const MaxJSONBody = 1 << 20

var (
	// JSON field names are lowerCamelCase (UseProtoNames=false); scalar defaults are emitted.
	marshalOpts   = protojson.MarshalOptions{EmitDefaultValues: true}
	unmarshalOpts = protojson.UnmarshalOptions{DiscardUnknown: true}
)

// Decode reads a protojson body into msg. An empty body leaves msg zero-valued.
func Decode(w http.ResponseWriter, r *http.Request, msg proto.Message) error {
	return decode(w, r, msg, unmarshalOpts)
}

// DecodeStrict rejects unknown properties, including those nested in messages.
// Use it for APIs whose contract must not silently discard client intent.
func DecodeStrict(w http.ResponseWriter, r *http.Request, msg proto.Message) error {
	return decode(w, r, msg, protojson.UnmarshalOptions{})
}

func decode(w http.ResponseWriter, r *http.Request, msg proto.Message, opts protojson.UnmarshalOptions) error {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxJSONBody))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return Coded(http.StatusRequestEntityTooLarge, v1.ErrorCode_ERROR_CODE_PAYLOAD_TOO_LARGE, "request body too large")
		}
		return BadRequest("cannot read body")
	}
	if len(body) == 0 {
		return nil
	}
	if err := opts.Unmarshal(body, msg); err != nil {
		return BadRequest("invalid JSON: " + err.Error())
	}
	return nil
}

// Write encodes msg as protojson with the given status.
func Write(w http.ResponseWriter, status int, msg proto.Message) {
	b, err := marshalOpts.Marshal(msg)
	if err != nil {
		slog.Error("marshal response", "err", err)
		http.Error(w, `{"code":"ERROR_CODE_INTERNAL","message":"internal error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

// NoContent writes 204.
func NoContent(w http.ResponseWriter) {
	w.WriteHeader(http.StatusNoContent)
}

// StatusClientClosed is the nginx-style status for a request the client abandoned
// (connection closed / fetch aborted) before the server answered. It is not a server
// failure: logged at debug level, and not a 5xx in logs or metrics.
const StatusClientClosed = 499

// WriteError writes err as ApiError JSON and logs server-side failures. A failure caused by
// the client going away (request context canceled, e.g. a reload right after a POST) is
// answered with 499 instead of 500 and is not logged as an error.
func WriteError(w http.ResponseWriter, r *http.Request, err error) {
	e := AsError(err)
	if e.Status >= 500 && errors.Is(r.Context().Err(), context.Canceled) {
		slog.DebugContext(r.Context(), "request canceled by the client", "err", safeLogError(r, err), "request_id", RequestID(r.Context()),
			"method", r.Method, "path", safeLogPath(r))
		w.WriteHeader(StatusClientClosed) // nobody reads the body
		return
	}
	if e.RetryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(int(e.RetryAfter.Seconds())))
	}
	if e.Status >= 500 {
		slog.ErrorContext(r.Context(), "request failed", "err", safeLogError(r, err), "request_id", RequestID(r.Context()),
			"method", r.Method, "path", safeLogPath(r))
	}
	Write(w, e.Status, e.Proto())
}
