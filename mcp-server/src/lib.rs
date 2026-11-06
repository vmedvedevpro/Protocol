//! Read-only MCP server over Protocol's meeting library (#8). The binary in
//! `main.rs` wires these modules to stdio; tests drive them directly.

pub mod location;
pub mod server;
pub mod store;
pub mod text;
pub mod tools;
