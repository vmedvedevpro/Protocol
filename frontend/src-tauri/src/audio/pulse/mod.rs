//! The Linux sound server: PipeWire (through `pipewire-pulse`) or PulseAudio,
//! reached over PulseAudio's native protocol (#216).
//!
//! cpal 0.15 only has an ALSA host on Linux. Listing its inputs opens every
//! ALSA PCM in turn (25 on the owner's laptop, each logging `pcm_dmix ...
//! supports only playback stream` and the like), names them by their raw PCM
//! names, and cannot see a sound server's monitor sources at all. The sound
//! server already knows every input and every output's monitor, with a human
//! description and a stable name, and answers in one round trip without
//! opening any device.
//!
//! The `pulseaudio` crate is a pure Rust implementation of the protocol (no
//! libpulse to link or ship), and it is what cpal 0.18's own PulseAudio host
//! uses. Its high-level `Client` is not used: its reactor thread ignores
//! `RecordStreamKilled` (an unplugged device would go silent without an
//! error) and never ends. This module speaks the protocol on plain blocking
//! sockets instead, one connection per listing and one per record stream, so
//! each owner sees every server message and closes its socket when done.

pub mod devices;
pub mod record;

use std::ffi::CString;
use std::io::BufReader;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use pulseaudio::protocol::{self, Command, CommandReply};

/// How long a reply may take. A healthy server answers in milliseconds; a
/// hung one must not hold a listing (and every caller waiting on it) forever.
const REPLY_TIMEOUT: Duration = Duration::from_secs(3);

/// The length of PulseAudio's auth cookie (`PA_NATIVE_COOKIE_LENGTH`).
const COOKIE_LENGTH: usize = 256;

/// Where the server's socket is, as libpulse looks for it: `$PULSE_SERVER`
/// (its first local entry), else `$PULSE_RUNTIME_PATH/native`, else
/// `$XDG_RUNTIME_DIR/pulse/native`. `pipewire-pulse` listens on the last one.
/// None when no local socket exists: no sound server runs for this user.
pub fn socket_path() -> Option<PathBuf> {
    if let Ok(servers) = std::env::var("PULSE_SERVER") {
        // A list of servers separated by spaces; only local sockets are used.
        let local = servers.split_whitespace().find_map(|server| {
            let path = server.strip_prefix("unix:").unwrap_or(server);
            path.starts_with('/').then(|| PathBuf::from(path))
        });
        return local.filter(|path| path.exists());
    }
    let runtime = std::env::var_os("PULSE_RUNTIME_PATH")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("XDG_RUNTIME_DIR").map(|dir| PathBuf::from(dir).join("pulse")))?;
    Some(runtime.join("native")).filter(|path| path.exists())
}

/// Whether a sound server runs for this user. A socket file left behind by a
/// server that has exited still counts; connecting to it then fails, and that
/// failure is reported rather than switching to ALSA behind the user's back.
pub fn available() -> bool {
    socket_path().is_some()
}

/// One authenticated connection to the server.
pub(crate) struct Connection {
    reader: BufReader<UnixStream>,
    version: u16,
    next_seq: u32,
}

impl Connection {
    /// Connects, authenticates and names the client "Protocol" (what
    /// pavucontrol and KDE's audio applet show beside its record streams).
    pub fn open() -> Result<Self> {
        let path = socket_path().ok_or_else(|| anyhow!("no PipeWire or PulseAudio server is running"))?;
        let socket = UnixStream::connect(&path)
            .with_context(|| format!("cannot connect to the sound server at {}", path.display()))?;
        socket.set_read_timeout(Some(REPLY_TIMEOUT))?;
        socket.set_write_timeout(Some(REPLY_TIMEOUT))?;
        let mut connection = Self { reader: BufReader::new(socket), version: protocol::MAX_VERSION, next_seq: 0 };

        // The cookie libpulse keeps (`$PULSE_COOKIE`, `~/.config/pulse/cookie`).
        // A user's own socket lets the user in by its credentials, so the
        // content rarely matters, but its length does: `pipewire-pulse`
        // refuses an Auth whose cookie is not 256 bytes ("Invalid"), which an
        // empty one was in a profile where no libpulse client had made the
        // file yet. Zeros stand in for a missing or unreadable one.
        let cookie = pulseaudio::cookie_path_from_env()
            .and_then(|path| std::fs::read(path).ok())
            .filter(|cookie| cookie.len() == COOKIE_LENGTH)
            .unwrap_or_else(|| vec![0; COOKIE_LENGTH]);
        let auth: protocol::AuthReply = connection.roundtrip(Command::Auth(protocol::AuthParams {
            version: protocol::MAX_VERSION,
            supports_shm: false,
            supports_memfd: false,
            cookie,
        }))?;
        connection.version = protocol::MAX_VERSION.min(auth.version);

        let mut props = protocol::Props::new();
        props.set(protocol::Prop::ApplicationName, c"Protocol");
        props.set(protocol::Prop::ApplicationId, c"io.github.vmedvedevpro.protocol");
        props.set(protocol::Prop::ApplicationIconName, c"protocol");
        props.set(
            protocol::Prop::ApplicationProcessId,
            CString::new(std::process::id().to_string()).expect("a number has no NUL"),
        );
        let _: protocol::SetClientNameReply = connection.roundtrip(Command::SetClientName(props))?;
        Ok(connection)
    }

    /// Sends a command and reads its reply. Used before any stream exists,
    /// so the next message from the server is this reply.
    pub fn roundtrip<R: CommandReply>(&mut self, command: Command) -> Result<R> {
        let seq = self.next_seq;
        self.next_seq += 1;
        let name = format!("{:?}", command.tag());
        protocol::write_command_message(self.reader.get_mut(), seq, &command, self.version)
            .with_context(|| format!("cannot send {name} to the sound server"))?;
        let (reply_seq, reply) = protocol::read_reply_message::<R>(&mut self.reader, self.version)
            .with_context(|| format!("the sound server did not answer {name}"))?;
        anyhow::ensure!(reply_seq == seq, "the sound server answered {name} out of order");
        Ok(reply)
    }

    pub fn version(&self) -> u16 {
        self.version
    }

    pub fn into_reader(self) -> BufReader<UnixStream> {
        self.reader
    }
}
