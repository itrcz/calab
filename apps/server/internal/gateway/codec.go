package gateway

import (
	"github.com/coder/websocket"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// codec encodes frames for one socket: binary protobuf (default) or protojson text frames
// (?encoding=json, for debugging).
type codec struct{ json bool }

var jsonOpts = protojson.MarshalOptions{EmitDefaultValues: true}

func (c codec) encode(f *v1.GatewayFrame) (websocket.MessageType, []byte, error) {
	if c.json {
		b, err := jsonOpts.Marshal(f)
		return websocket.MessageText, b, err
	}
	b, err := proto.Marshal(f)
	return websocket.MessageBinary, b, err
}

func (c codec) decode(typ websocket.MessageType, b []byte) (*v1.GatewayFrame, error) {
	f := &v1.GatewayFrame{}
	var err error
	if typ == websocket.MessageText {
		err = protojson.UnmarshalOptions{DiscardUnknown: true}.Unmarshal(b, f)
	} else {
		err = proto.Unmarshal(b, f)
	}
	return f, err
}

// transcode turns a stored binary frame into this socket's encoding.
func (c codec) transcode(bin []byte) (websocket.MessageType, []byte, error) {
	if !c.json {
		return websocket.MessageBinary, bin, nil
	}
	f := &v1.GatewayFrame{}
	if err := proto.Unmarshal(bin, f); err != nil {
		return 0, nil, err
	}
	return c.encode(f)
}

// opOf returns the opcode that must accompany a payload.
func opOf(f *v1.GatewayFrame) v1.GatewayOpcode {
	switch f.GetPayload().(type) {
	case *v1.GatewayFrame_Heartbeat:
		return v1.GatewayOpcode_GATEWAY_OPCODE_HEARTBEAT
	case *v1.GatewayFrame_Identify:
		return v1.GatewayOpcode_GATEWAY_OPCODE_IDENTIFY
	case *v1.GatewayFrame_Resume:
		return v1.GatewayOpcode_GATEWAY_OPCODE_RESUME
	case *v1.GatewayFrame_SetPresence:
		return v1.GatewayOpcode_GATEWAY_OPCODE_PRESENCE_UPDATE
	case *v1.GatewayFrame_Typing:
		return v1.GatewayOpcode_GATEWAY_OPCODE_TYPING
	case *v1.GatewayFrame_Subscribe:
		return v1.GatewayOpcode_GATEWAY_OPCODE_SUBSCRIBE
	case *v1.GatewayFrame_RecordingSpeech:
		return v1.GatewayOpcode_GATEWAY_OPCODE_RECORDING_SPEECH
	case *v1.GatewayFrame_Hello:
		return v1.GatewayOpcode_GATEWAY_OPCODE_HELLO
	case *v1.GatewayFrame_HeartbeatAck:
		return v1.GatewayOpcode_GATEWAY_OPCODE_HEARTBEAT_ACK
	case *v1.GatewayFrame_Reconnect:
		return v1.GatewayOpcode_GATEWAY_OPCODE_RECONNECT
	case *v1.GatewayFrame_InvalidSession:
		return v1.GatewayOpcode_GATEWAY_OPCODE_INVALID_SESSION
	case *v1.GatewayFrame_Dispatch:
		return v1.GatewayOpcode_GATEWAY_OPCODE_DISPATCH
	}
	return v1.GatewayOpcode_GATEWAY_OPCODE_UNSPECIFIED
}

// frame builds a server frame with the matching opcode.
func frame(f *v1.GatewayFrame) *v1.GatewayFrame {
	f.Op = opOf(f)
	return f
}
