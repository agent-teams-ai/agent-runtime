//! Test-only protocol endpoint. It proves the negotiated wire contract without
//! starting a provider process or importing Guardian's runtime result model.

use boundary_protocol::{
    ClientHello, CompatibilityResponse, CompatibilityResult, GuardianCommand, RequestEnvelope,
    decode_client_hello, decode_negotiated_request, encode_server_hello_ack,
    encode_server_hello_rejection, negotiate_protocol, project_negotiated_compatibility_response,
};
use std::io::{self, BufRead, BufReader, BufWriter, Write};

fn read_required_line(reader: &mut impl BufRead) -> io::Result<Vec<u8>> {
    let mut line = Vec::new();
    if reader.read_until(b'\n', &mut line)? == 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "expected a protocol frame",
        ));
    }
    Ok(line)
}

fn write_frame(writer: &mut impl Write, frame: &[u8]) -> io::Result<()> {
    writer.write_all(frame)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn operation_id(request: &RequestEnvelope) -> &str {
    match &request.command {
        GuardianCommand::Spawn { operation_id, .. }
        | GuardianCommand::Query { operation_id }
        | GuardianCommand::Terminate { operation_id, .. }
        | GuardianCommand::AdvanceFence { operation_id, .. } => operation_id,
        GuardianCommand::InspectContainment => "containment",
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());

    let client_hello: ClientHello = match decode_client_hello(&read_required_line(&mut reader)?) {
        Ok(hello) => hello,
        Err(error) => {
            write_frame(&mut writer, &encode_server_hello_rejection(&error)?)?;
            return Ok(());
        }
    };
    let negotiated = match negotiate_protocol(&client_hello) {
        Ok(negotiated) => negotiated,
        Err(error) => {
            write_frame(&mut writer, &encode_server_hello_rejection(&error)?)?;
            return Ok(());
        }
    };
    write_frame(&mut writer, &encode_server_hello_ack(negotiated)?)?;

    let request = decode_negotiated_request(&read_required_line(&mut reader)?, negotiated)?;
    let response = CompatibilityResponse {
        protocol_version: negotiated.version(),
        request_id: Some(request.request_id.clone()),
        result: CompatibilityResult::Accepted {
            operation_id: operation_id(&request).to_owned(),
            custody_state: "accepted".to_owned(),
            // This is deliberately opaque and demonstrates that a v1 wire
            // projection never leaks a field its frozen schema cannot parse.
            execution_id: Some("compatibility-execution-1".to_owned()),
        },
    };
    write_frame(
        &mut writer,
        &project_negotiated_compatibility_response(&response, negotiated)?,
    )?;
    Ok(())
}
