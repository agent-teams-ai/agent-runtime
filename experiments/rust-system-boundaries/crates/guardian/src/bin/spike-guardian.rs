use boundary_protocol::{ReadRequest, ResponseEnvelope, encode_response, read_next_request};
use execution_guardian::{DispatchOutcome, Guardian, GuardianResult};
use std::env;
use std::io::{BufReader, BufWriter};
use std::path::PathBuf;

fn argument(name: &str) -> String {
    let mut arguments = env::args().skip(1);
    while let Some(argument) = arguments.next() {
        if argument == name {
            return arguments
                .next()
                .unwrap_or_else(|| panic!("missing value for {name}"));
        }
    }
    panic!("missing {name}")
}

fn main() {
    let root = PathBuf::from(argument("--root"));
    let fixture_child = PathBuf::from(argument("--fixture-child"));
    let mut guardian = match Guardian::open(root, fixture_child) {
        Ok(guardian) => guardian,
        Err(error) => {
            eprintln!("Guardian startup rejected: {error}");
            std::process::exit(2);
        }
    };
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());
    while let Some(frame) = read_next_request(&mut reader).expect("stdin frame reads") {
        match frame {
            ReadRequest::Fatal(_) => break,
            ReadRequest::Frame(frame) => match frame {
                Ok(request) => match guardian.dispatch(request.clone()) {
                    DispatchOutcome::Respond(result) => {
                        encode_response(
                            &mut writer,
                            &ResponseEnvelope {
                                protocol_version: request.protocol_version,
                                request_id: Some(request.request_id),
                                result,
                            },
                        )
                        .expect("response writes");
                    }
                    DispatchOutcome::DropResponse => {}
                },
                Err(error) => {
                    encode_response(
                        &mut writer,
                        &ResponseEnvelope {
                            protocol_version: boundary_protocol::CURRENT_PROTOCOL_VERSION,
                            request_id: None,
                            result: GuardianResult::ProtocolRejected {
                                code: error.code,
                                detail: error.detail.to_owned(),
                            },
                        },
                    )
                    .expect("protocol rejection writes");
                }
            },
        }
    }
}
