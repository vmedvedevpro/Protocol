//! The built `protocol-mcp` executable, driven over stdio the way Claude Code
//! and Claude Desktop start it.

mod common;

use common::Fixture;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BINARY: &str = env!("CARGO_BIN_EXE_protocol-mcp");

#[test]
fn version_help_and_bad_arguments() {
    let version = Command::new(BINARY).arg("--version").output().unwrap();
    assert!(version.status.success());
    assert_eq!(String::from_utf8(version.stdout).unwrap().trim(), format!("protocol-mcp {}", env!("CARGO_PKG_VERSION")));

    let help = Command::new(BINARY).arg("--help").output().unwrap();
    assert!(help.status.success());
    assert!(String::from_utf8(help.stdout).unwrap().contains("--db <path>"));

    let bad = Command::new(BINARY).arg("--write").output().unwrap();
    assert_eq!(bad.status.code(), Some(2));
    assert!(bad.stdout.is_empty(), "stdout is reserved for the protocol");
}

#[tokio::test]
async fn a_client_session_over_stdio() {
    let fixture = Fixture::new().await;
    let mut child = Command::new(BINARY)
        .arg("--db")
        .arg(&fixture.db)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut send = |message: Value| {
        writeln!(stdin, "{message}").unwrap();
        stdin.flush().unwrap();
    };
    let mut receive = |id: i64| -> Value {
        loop {
            let mut line = String::new();
            assert!(stdout.read_line(&mut line).unwrap() > 0, "the server closed stdout");
            let message: Value = serde_json::from_str(&line).unwrap_or_else(|_| panic!("not JSON-RPC on stdout: {line}"));
            if message["id"] == id {
                return message;
            }
        }
    };

    send(json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "test", "version": "0" } }
    }));
    let initialized = receive(1);
    assert_eq!(initialized["result"]["serverInfo"]["name"], "protocol", "{initialized}");
    assert!(initialized["result"]["capabilities"]["tools"].is_object(), "{initialized}");
    send(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));

    send(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }));
    let listed = receive(2);
    assert_eq!(listed["result"]["tools"].as_array().unwrap().len(), 8, "{listed}");

    send(json!({
        "jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": { "name": "search", "arguments": { "query": "бюджет" } }
    }));
    let found = receive(3);
    let result = &found["result"];
    assert_ne!(result["isError"], true, "{found}");
    assert!(result.get("structuredContent").is_none(), "{found}");
    let text = result["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("Планёрка по бюджету"), "{text}");

    // Closing stdin is how clients stop a stdio server.
    drop(stdin);
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success(), "{status}");
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(10), "the server did not exit after stdin closed");
        std::thread::sleep(Duration::from_millis(50));
    }
}
