//! `protocol-mcp`: Protocol's meetings for AI agents, over MCP on stdio.
//! Read-only; see docs/MCP_SERVER.md.

use std::path::PathBuf;
use std::process::ExitCode;

use protocol_mcp::location::{Inputs, DB_ENV};
use protocol_mcp::server::{Config, ProtocolServer};
use rmcp::ServiceExt;

fn usage() -> String {
    format!(
        "protocol-mcp {version}: read-only MCP server (stdio) over Protocol's meetings.\n\
         \n\
         Usage: protocol-mcp [--db <path to meeting_minutes.sqlite>]\n\
         \n\
         An MCP client such as Claude Code starts it; Protocol > Settings > AI agents shows\n\
         the command. It answers only while that switch is on.\n\
         \n\
         Options:\n\
         \x20 --db <path>   read this database instead of Protocol's ({DB_ENV} also sets it)\n\
         \x20 --version     print the version\n\
         \x20 --help        print this help",
        version = env!("CARGO_PKG_VERSION")
    )
}

enum Command {
    Serve(Option<PathBuf>),
    Print(String),
}

fn parse(args: impl IntoIterator<Item = std::ffi::OsString>) -> Result<Command, String> {
    let mut db = None;
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--version" | "-V") => {
                return Ok(Command::Print(format!("protocol-mcp {}", env!("CARGO_PKG_VERSION"))))
            }
            Some("--help" | "-h") => return Ok(Command::Print(usage())),
            Some("--db") => {
                let path = args.next().ok_or("--db needs a path")?;
                db = Some(PathBuf::from(path));
            }
            Some(other) if other.starts_with("--db=") => db = Some(PathBuf::from(&other[5..])),
            _ => return Err(format!("unknown argument {arg:?}; see --help")),
        }
    }
    Ok(Command::Serve(db))
}

fn main() -> ExitCode {
    let db = match parse(std::env::args_os().skip(1)) {
        Ok(Command::Print(text)) => {
            println!("{text}");
            return ExitCode::SUCCESS;
        }
        Ok(Command::Serve(db)) => db,
        Err(message) => {
            eprintln!("protocol-mcp: {message}");
            return ExitCode::from(2);
        }
    };

    // Two workers: tool calls are short, and stdio reads use the blocking pool.
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("protocol-mcp: cannot start: {error}");
            return ExitCode::FAILURE;
        }
    };
    runtime.block_on(async move {
        let server = ProtocolServer::new(Config {
            inputs: Inputs::from_environment(db),
            watch: None,
        });
        // stdout carries the protocol; anything for a person goes to stderr,
        // which clients keep in their MCP logs.
        let service = match server.serve(rmcp::transport::stdio()).await {
            Ok(service) => service,
            Err(error) => {
                eprintln!("protocol-mcp: the client did not finish connecting: {error}");
                return ExitCode::FAILURE;
            }
        };
        match service.waiting().await {
            Ok(_) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("protocol-mcp: stopped: {error}");
                ExitCode::FAILURE
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(args: &[&str]) -> Result<Command, String> {
        parse(args.iter().map(std::ffi::OsString::from))
    }

    #[test]
    fn arguments() {
        assert!(matches!(run(&[]), Ok(Command::Serve(None))));
        assert!(matches!(run(&["--db", "x.sqlite"]), Ok(Command::Serve(Some(path))) if path == PathBuf::from("x.sqlite")));
        assert!(matches!(run(&["--db=y.sqlite"]), Ok(Command::Serve(Some(path))) if path == PathBuf::from("y.sqlite")));
        assert!(matches!(run(&["--version"]), Ok(Command::Print(text)) if text.starts_with("protocol-mcp ")));
        assert!(run(&["--db"]).is_err());
        assert!(run(&["--write"]).is_err());
    }
}
