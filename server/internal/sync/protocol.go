package sync

// Protocol error codes. These are binding/protocol-level failures that
// abort the whole sync round; per-operation conflicts travel as normal
// results with HTTP 200.
const (
	CodeEpochMismatch           = "EPOCH_MISMATCH"
	CodeHistoryExpired          = "HISTORY_EXPIRED"
	CodeOperationHistoryExpired = "OPERATION_HISTORY_EXPIRED"
	CodeBindingNotActive        = "BINDING_NOT_ACTIVE"
	CodeSyncProtocolUnsupported = "SYNC_PROTOCOL_UNSUPPORTED"
	CodeOpIDReused              = "OP_ID_REUSED"
	CodeClientSeqRegressed      = "CLIENT_SEQ_REGRESSED"
	CodeInvalidWatermark        = "INVALID_WATERMARK"
)

// ProtocolError is a machine-readable sync protocol failure. Clients act
// on Code, not on the message.
type ProtocolError struct {
	Code    string
	Message string
}

func (e *ProtocolError) Error() string { return e.Code + ": " + e.Message }

func protocolErr(code, message string) *ProtocolError {
	return &ProtocolError{Code: code, Message: message}
}
