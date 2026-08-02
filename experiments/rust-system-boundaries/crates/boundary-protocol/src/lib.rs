//! Narrow, versioned, language-neutral NDJSON framing for the Guardian spike.
//!
//! It intentionally contains only technical process-custody vocabulary. Runtime
//! domain models, authorization policy, leases, and distributed state do not
//! cross this boundary.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::io::{self, BufRead, Write};

pub const CURRENT_PROTOCOL_VERSION: u16 = 2;
pub const MINIMUM_PROTOCOL_VERSION: u16 = 1;
pub const MAX_FRAME_BYTES: usize = 64 * 1024;
pub const MAX_OVERSIZED_FRAME_DRAIN_BYTES: usize = MAX_FRAME_BYTES;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProtocolErrorCode {
    UnsupportedVersion,
    UnsupportedFeature,
    MalformedFrame,
    FrameTooLarge,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolError {
    pub code: ProtocolErrorCode,
    pub detail: &'static str,
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?}: {}", self.code, self.detail)
    }
}

impl std::error::Error for ProtocolError {}

/// Canonical in-process representation. Its serialization is always projected
/// through the declared wire version rather than exposing one shared DTO.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestEnvelope {
    pub protocol_version: u16,
    pub request_id: String,
    pub command: GuardianCommand,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GuardianCommand {
    Spawn {
        operation_id: String,
        opaque_fence: String,
        fixture_mode: String,
        drop_response: bool,
    },
    Query {
        operation_id: String,
    },
    Terminate {
        operation_id: String,
        opaque_fence: String,
    },
    /// A caller-owned custody fence rotation. Guardian only compares and
    /// persists opaque values; it does not decide when a rotation is allowed.
    AdvanceFence {
        operation_id: String,
        current_opaque_fence: String,
        next_opaque_fence: String,
    },
    InspectContainment,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResponseEnvelope<T> {
    pub protocol_version: u16,
    pub request_id: Option<String>,
    pub result: T,
}

/// The caller must close the stream after `Fatal`; no later frame is trusted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadRequest {
    Frame(Result<RequestEnvelope, ProtocolError>),
    Fatal(ProtocolError),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct V1RequestEnvelope {
    protocol_version: u16,
    request_id: String,
    command: V1GuardianCommand,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
enum V1GuardianCommand {
    Spawn {
        operation_id: String,
        opaque_fence: String,
        fixture_mode: String,
    },
    Query {
        operation_id: String,
    },
    Terminate {
        operation_id: String,
        opaque_fence: String,
    },
    InspectContainment {},
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct V2RequestEnvelope {
    protocol_version: u16,
    request_id: String,
    command: V2GuardianCommand,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
enum V2GuardianCommand {
    Spawn {
        operation_id: String,
        opaque_fence: String,
        fixture_mode: String,
        drop_response: bool,
    },
    Query {
        operation_id: String,
    },
    Terminate {
        operation_id: String,
        opaque_fence: String,
    },
    AdvanceFence {
        operation_id: String,
        current_opaque_fence: String,
        next_opaque_fence: String,
    },
    InspectContainment {},
}

#[derive(Serialize)]
struct V1ResponseEnvelope<'a, T> {
    protocol_version: u16,
    request_id: &'a Option<String>,
    result: &'a T,
}

#[derive(Serialize)]
struct V2ResponseEnvelope<'a, T> {
    protocol_version: u16,
    request_id: &'a Option<String>,
    result: &'a T,
}

enum ProjectedRequest {
    V1(V1RequestEnvelope),
    V2(V2RequestEnvelope),
}

impl Serialize for ProjectedRequest {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Self::V1(request) => request.serialize(serializer),
            Self::V2(request) => request.serialize(serializer),
        }
    }
}

impl From<V1RequestEnvelope> for RequestEnvelope {
    fn from(value: V1RequestEnvelope) -> Self {
        Self {
            protocol_version: value.protocol_version,
            request_id: value.request_id,
            command: match value.command {
                V1GuardianCommand::Spawn {
                    operation_id,
                    opaque_fence,
                    fixture_mode,
                } => GuardianCommand::Spawn {
                    operation_id,
                    opaque_fence,
                    fixture_mode,
                    drop_response: false,
                },
                V1GuardianCommand::Query { operation_id } => {
                    GuardianCommand::Query { operation_id }
                }
                V1GuardianCommand::Terminate {
                    operation_id,
                    opaque_fence,
                } => GuardianCommand::Terminate {
                    operation_id,
                    opaque_fence,
                },
                V1GuardianCommand::InspectContainment {} => GuardianCommand::InspectContainment,
            },
        }
    }
}

impl From<V2RequestEnvelope> for RequestEnvelope {
    fn from(value: V2RequestEnvelope) -> Self {
        Self {
            protocol_version: value.protocol_version,
            request_id: value.request_id,
            command: match value.command {
                V2GuardianCommand::Spawn {
                    operation_id,
                    opaque_fence,
                    fixture_mode,
                    drop_response,
                } => GuardianCommand::Spawn {
                    operation_id,
                    opaque_fence,
                    fixture_mode,
                    drop_response,
                },
                V2GuardianCommand::Query { operation_id } => {
                    GuardianCommand::Query { operation_id }
                }
                V2GuardianCommand::Terminate {
                    operation_id,
                    opaque_fence,
                } => GuardianCommand::Terminate {
                    operation_id,
                    opaque_fence,
                },
                V2GuardianCommand::AdvanceFence {
                    operation_id,
                    current_opaque_fence,
                    next_opaque_fence,
                } => GuardianCommand::AdvanceFence {
                    operation_id,
                    current_opaque_fence,
                    next_opaque_fence,
                },
                V2GuardianCommand::InspectContainment {} => GuardianCommand::InspectContainment,
            },
        }
    }
}

pub fn validate_protocol_version(version: u16) -> Result<(), ProtocolError> {
    if (MINIMUM_PROTOCOL_VERSION..=CURRENT_PROTOCOL_VERSION).contains(&version) {
        Ok(())
    } else {
        Err(ProtocolError {
            code: ProtocolErrorCode::UnsupportedVersion,
            detail: "only current and N-1 protocol versions are accepted",
        })
    }
}

pub fn decode_request(frame: &[u8]) -> Result<RequestEnvelope, ProtocolError> {
    if frame.len() > MAX_FRAME_BYTES {
        return Err(frame_too_large_error());
    }

    let frame = std::str::from_utf8(frame).map_err(|_| ProtocolError {
        code: ProtocolErrorCode::MalformedFrame,
        detail: "frame is not valid UTF-8",
    })?;
    let frame = frame.strip_suffix('\n').unwrap_or(frame);
    let value = serde_json::from_str::<serde_json::Value>(frame).map_err(|_| malformed_error())?;
    decode_request_value(value)
}

/// Projects the canonical request into its frozen protocol-version DTO.
pub fn project_request(request: &RequestEnvelope) -> Result<Vec<u8>, ProtocolError> {
    serde_json::to_vec(&project_request_wire(request)?).map_err(|_| ProtocolError {
        code: ProtocolErrorCode::MalformedFrame,
        detail: "request could not be projected into its protocol version",
    })
}

pub fn encode_response<T: Serialize>(
    writer: &mut impl Write,
    response: &ResponseEnvelope<T>,
) -> io::Result<()> {
    let bytes = project_response(response).map_err(protocol_error_to_io)?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "response exceeds the bounded protocol limit",
        ));
    }
    writer.write_all(&bytes)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

/// Reads one NDJSON request. Once an oversized frame exceeds the finite drain
/// allowance, callers must close the connection after receiving `Fatal`.
pub fn read_next_request(reader: &mut impl BufRead) -> io::Result<Option<ReadRequest>> {
    let mut frame = Vec::with_capacity(MAX_FRAME_BYTES);
    let mut received_any = false;
    let mut oversized = false;
    let mut drained_oversized_bytes = 0usize;

    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if !received_any {
                Ok(None)
            } else if oversized {
                Ok(Some(ReadRequest::Frame(Err(frame_too_large_error()))))
            } else {
                Ok(Some(ReadRequest::Frame(decode_request(&frame))))
            };
        }
        received_any = true;

        let newline = available.iter().position(|byte| *byte == b'\n');
        let payload_len = newline.unwrap_or(available.len());
        let completed = newline.is_some();

        if !oversized {
            let remaining = MAX_FRAME_BYTES.saturating_sub(frame.len());
            if payload_len <= remaining {
                frame.extend_from_slice(&available[..payload_len]);
                reader.consume(payload_len + usize::from(completed));
                if completed {
                    return Ok(Some(ReadRequest::Frame(decode_request(&frame))));
                }
                continue;
            }

            frame.extend_from_slice(&available[..remaining]);
            oversized = true;
            let excess = payload_len - remaining;
            let allowed = excess.min(MAX_OVERSIZED_FRAME_DRAIN_BYTES);
            let consumed_payload = remaining + allowed;
            drained_oversized_bytes = allowed;
            reader.consume(consumed_payload);

            if excess > allowed {
                return Ok(Some(ReadRequest::Fatal(frame_drain_limit_error())));
            }
            if completed {
                reader.consume(1);
                return Ok(Some(ReadRequest::Frame(Err(frame_too_large_error()))));
            }
            continue;
        }

        let remaining_drain =
            MAX_OVERSIZED_FRAME_DRAIN_BYTES.saturating_sub(drained_oversized_bytes);
        let allowed = payload_len.min(remaining_drain);
        reader.consume(allowed);
        drained_oversized_bytes += allowed;

        if payload_len > allowed {
            return Ok(Some(ReadRequest::Fatal(frame_drain_limit_error())));
        }
        if completed {
            reader.consume(1);
            return Ok(Some(ReadRequest::Frame(Err(frame_too_large_error()))));
        }
    }
}

impl Serialize for RequestEnvelope {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        project_request_wire(self)
            .map_err(serde::ser::Error::custom)?
            .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for RequestEnvelope {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        decode_request_value(value).map_err(serde::de::Error::custom)
    }
}

fn decode_request_value(value: serde_json::Value) -> Result<RequestEnvelope, ProtocolError> {
    let version = value
        .get("protocol_version")
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .ok_or_else(malformed_error)?;
    validate_protocol_version(version)?;

    match version {
        1 => serde_json::from_value::<V1RequestEnvelope>(value)
            .map(RequestEnvelope::from)
            .map_err(|_| malformed_error()),
        2 => serde_json::from_value::<V2RequestEnvelope>(value)
            .map(RequestEnvelope::from)
            .map_err(|_| malformed_error()),
        _ => unreachable!("validated protocol versions are exhaustive"),
    }
}

fn project_request_wire(request: &RequestEnvelope) -> Result<ProjectedRequest, ProtocolError> {
    validate_protocol_version(request.protocol_version)?;
    match request.protocol_version {
        1 => {
            let command = match &request.command {
                GuardianCommand::Spawn {
                    operation_id,
                    opaque_fence,
                    fixture_mode,
                    drop_response: false,
                } => V1GuardianCommand::Spawn {
                    operation_id: operation_id.clone(),
                    opaque_fence: opaque_fence.clone(),
                    fixture_mode: fixture_mode.clone(),
                },
                GuardianCommand::Spawn {
                    drop_response: true,
                    ..
                }
                | GuardianCommand::AdvanceFence { .. } => return Err(v1_feature_error()),
                GuardianCommand::Query { operation_id } => V1GuardianCommand::Query {
                    operation_id: operation_id.clone(),
                },
                GuardianCommand::Terminate {
                    operation_id,
                    opaque_fence,
                } => V1GuardianCommand::Terminate {
                    operation_id: operation_id.clone(),
                    opaque_fence: opaque_fence.clone(),
                },
                GuardianCommand::InspectContainment => V1GuardianCommand::InspectContainment {},
            };
            Ok(ProjectedRequest::V1(V1RequestEnvelope {
                protocol_version: 1,
                request_id: request.request_id.clone(),
                command,
            }))
        }
        2 => {
            let command = match &request.command {
                GuardianCommand::Spawn {
                    operation_id,
                    opaque_fence,
                    fixture_mode,
                    drop_response,
                } => V2GuardianCommand::Spawn {
                    operation_id: operation_id.clone(),
                    opaque_fence: opaque_fence.clone(),
                    fixture_mode: fixture_mode.clone(),
                    drop_response: *drop_response,
                },
                GuardianCommand::Query { operation_id } => V2GuardianCommand::Query {
                    operation_id: operation_id.clone(),
                },
                GuardianCommand::Terminate {
                    operation_id,
                    opaque_fence,
                } => V2GuardianCommand::Terminate {
                    operation_id: operation_id.clone(),
                    opaque_fence: opaque_fence.clone(),
                },
                GuardianCommand::AdvanceFence {
                    operation_id,
                    current_opaque_fence,
                    next_opaque_fence,
                } => V2GuardianCommand::AdvanceFence {
                    operation_id: operation_id.clone(),
                    current_opaque_fence: current_opaque_fence.clone(),
                    next_opaque_fence: next_opaque_fence.clone(),
                },
                GuardianCommand::InspectContainment => V2GuardianCommand::InspectContainment {},
            };
            Ok(ProjectedRequest::V2(V2RequestEnvelope {
                protocol_version: 2,
                request_id: request.request_id.clone(),
                command,
            }))
        }
        _ => unreachable!("validated protocol versions are exhaustive"),
    }
}

fn project_response<T: Serialize>(
    response: &ResponseEnvelope<T>,
) -> Result<Vec<u8>, ProtocolError> {
    validate_protocol_version(response.protocol_version)?;
    match response.protocol_version {
        1 => serde_json::to_vec(&V1ResponseEnvelope {
            protocol_version: 1,
            request_id: &response.request_id,
            result: &response.result,
        })
        .map_err(|_| malformed_error()),
        2 => serde_json::to_vec(&V2ResponseEnvelope {
            protocol_version: 2,
            request_id: &response.request_id,
            result: &response.result,
        })
        .map_err(|_| malformed_error()),
        _ => unreachable!("validated protocol versions are exhaustive"),
    }
}

fn malformed_error() -> ProtocolError {
    ProtocolError {
        code: ProtocolErrorCode::MalformedFrame,
        detail: "frame does not match the closed-world protocol schema",
    }
}

fn v1_feature_error() -> ProtocolError {
    ProtocolError {
        code: ProtocolErrorCode::UnsupportedFeature,
        detail: "requested command field is not representable by protocol version 1",
    }
}

fn frame_too_large_error() -> ProtocolError {
    ProtocolError {
        code: ProtocolErrorCode::FrameTooLarge,
        detail: "NDJSON frame exceeds the bounded protocol limit",
    }
}

fn frame_drain_limit_error() -> ProtocolError {
    ProtocolError {
        code: ProtocolErrorCode::FrameTooLarge,
        detail: "oversized NDJSON frame exceeded the finite drain limit; connection is terminal",
    }
}

fn protocol_error_to_io(error: ProtocolError) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};

    const V1_SPAWN_GOLDEN: &str = include_str!("../tests/fixtures/v1-spawn.json");
    const V2_SPAWN_GOLDEN: &str = include_str!("../tests/fixtures/v2-spawn.json");
    const V2_ADVANCE_FENCE_GOLDEN: &str = include_str!("../tests/fixtures/v2-advance-fence.json");

    fn inspect_frame(version: u16) -> String {
        format!(
            r#"{{"protocol_version":{version},"request_id":"request-1","command":{{"kind":"inspect_containment"}}}}"#
        )
    }

    fn golden_bytes(golden: &str) -> &[u8] {
        golden.trim_end().as_bytes()
    }

    #[test]
    fn current_and_previous_versions_are_accepted() {
        assert!(decode_request(inspect_frame(CURRENT_PROTOCOL_VERSION).as_bytes()).is_ok());
        assert!(decode_request(inspect_frame(CURRENT_PROTOCOL_VERSION - 1).as_bytes()).is_ok());
    }

    #[test]
    fn newer_and_n_minus_two_versions_fail_closed() {
        assert_eq!(
            decode_request(inspect_frame(CURRENT_PROTOCOL_VERSION + 1).as_bytes())
                .expect_err("newer version must be rejected")
                .code,
            ProtocolErrorCode::UnsupportedVersion
        );
        assert_eq!(
            decode_request(inspect_frame(CURRENT_PROTOCOL_VERSION - 2).as_bytes())
                .expect_err("N-2 version must be rejected")
                .code,
            ProtocolErrorCode::UnsupportedVersion
        );
    }

    #[test]
    fn frozen_golden_requests_project_to_distinct_v1_and_v2_shapes() {
        let v1 = decode_request(V1_SPAWN_GOLDEN.as_bytes()).expect("v1 golden decodes");
        let v2 = decode_request(V2_SPAWN_GOLDEN.as_bytes()).expect("v2 golden decodes");
        let advance =
            decode_request(V2_ADVANCE_FENCE_GOLDEN.as_bytes()).expect("v2 advance golden decodes");

        assert_eq!(
            project_request(&v1).expect("v1 projects"),
            golden_bytes(V1_SPAWN_GOLDEN)
        );
        assert_eq!(
            project_request(&v2).expect("v2 projects"),
            golden_bytes(V2_SPAWN_GOLDEN)
        );
        assert_eq!(
            project_request(&advance).expect("v2 advance projects"),
            golden_bytes(V2_ADVANCE_FENCE_GOLDEN)
        );
        assert_ne!(V1_SPAWN_GOLDEN, V2_SPAWN_GOLDEN);
    }

    #[test]
    fn v1_rejects_v2_only_fields_and_commands() {
        let v1_with_drop_response = V1_SPAWN_GOLDEN.trim_end().replace(
            "\"fixture_mode\":\"tree\"",
            "\"fixture_mode\":\"tree\",\"drop_response\":false",
        );
        assert_eq!(
            decode_request(v1_with_drop_response.as_bytes())
                .expect_err("v1 drop response field must fail closed")
                .code,
            ProtocolErrorCode::MalformedFrame
        );

        let v1_advance =
            V2_ADVANCE_FENCE_GOLDEN.replace("\"protocol_version\":2", "\"protocol_version\":1");
        assert_eq!(
            decode_request(v1_advance.as_bytes())
                .expect_err("v1 advance command must fail closed")
                .code,
            ProtocolErrorCode::MalformedFrame
        );

        let v1_drop_projection = RequestEnvelope {
            protocol_version: 1,
            request_id: "v1-drop".to_owned(),
            command: GuardianCommand::Spawn {
                operation_id: "operation-1".to_owned(),
                opaque_fence: "fence-a".to_owned(),
                fixture_mode: "tree".to_owned(),
                drop_response: true,
            },
        };
        assert_eq!(
            project_request(&v1_drop_projection)
                .expect_err("v1 cannot project v2-only response suppression")
                .code,
            ProtocolErrorCode::UnsupportedFeature
        );
    }

    #[test]
    fn malformed_or_unknown_fields_fail_closed() {
        assert_eq!(
            decode_request(b"not-json")
                .expect_err("invalid JSON must fail")
                .code,
            ProtocolErrorCode::MalformedFrame
        );
        assert_eq!(
            decode_request(
                br#"{"protocol_version":2,"request_id":"request-1","unexpected":true,"command":{"kind":"inspect_containment"}}"#,
            )
            .expect_err("unknown envelope fields must fail")
            .code,
            ProtocolErrorCode::MalformedFrame
        );
        assert_eq!(
            decode_request(
                br#"{"protocol_version":2,"request_id":"request-1","command":{"kind":"inspect_containment","unexpected":true}}"#,
            )
            .expect_err("unknown command fields must fail")
            .code,
            ProtocolErrorCode::MalformedFrame
        );
    }

    #[test]
    fn oversized_frame_fails_closed() {
        let oversized = vec![b'x'; MAX_FRAME_BYTES + 1];
        assert_eq!(
            decode_request(&oversized)
                .expect_err("oversized frame must fail")
                .code,
            ProtocolErrorCode::FrameTooLarge
        );
    }

    #[test]
    fn oversized_stream_is_drained_within_the_bounded_allowance() {
        let mut bytes = vec![b'x'; MAX_FRAME_BYTES + 128];
        bytes.push(b'\n');
        bytes.extend_from_slice(inspect_frame(CURRENT_PROTOCOL_VERSION).as_bytes());
        bytes.push(b'\n');
        let mut reader = BufReader::with_capacity(97, Cursor::new(bytes));

        assert!(matches!(
            read_next_request(&mut reader)
                .expect("oversized frame read")
                .expect("a frame must be present"),
            ReadRequest::Frame(Err(ProtocolError {
                code: ProtocolErrorCode::FrameTooLarge,
                ..
            }))
        ));
        let ReadRequest::Frame(Ok(request)) = read_next_request(&mut reader)
            .expect("valid frame read")
            .expect("a frame must be present")
        else {
            panic!("valid frame must decode after bounded drain");
        };
        assert_eq!(request.request_id, "request-1");
    }

    #[test]
    fn oversized_stream_exceeding_drain_limit_is_connection_fatal() {
        let bytes = vec![b'x'; MAX_FRAME_BYTES + MAX_OVERSIZED_FRAME_DRAIN_BYTES + 1];
        let mut reader = BufReader::with_capacity(97, Cursor::new(bytes));

        assert!(matches!(
            read_next_request(&mut reader)
                .expect("oversized frame read")
                .expect("a frame must be present"),
            ReadRequest::Fatal(ProtocolError {
                code: ProtocolErrorCode::FrameTooLarge,
                ..
            })
        ));
    }

    #[test]
    fn response_projection_rejects_unsupported_versions() {
        let mut bytes = Vec::new();
        let error = encode_response(
            &mut bytes,
            &ResponseEnvelope {
                protocol_version: CURRENT_PROTOCOL_VERSION + 1,
                request_id: None,
                result: serde_json::json!({ "status": "rejected" }),
            },
        )
        .expect_err("unknown response version must fail");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }
}
