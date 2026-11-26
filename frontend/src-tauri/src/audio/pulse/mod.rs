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
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Once;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use pulseaudio::protocol::{self, Command, CommandReply};

/// How long a reply may take. A healthy server answers in milliseconds; a
/// hung one must not hold a listing (and every caller waiting on it) forever.
const REPLY_TIMEOUT: Duration = Duration::from_secs(3);

/// The length of PulseAudio's auth cookie (`PA_NATIVE_COOKIE_LENGTH`).
const COOKIE_LENGTH: usize = 256;

/// Where the server's socket is, as libpulse looks for it: `$PULSE_SERVER`
/// (its first local entry that exists), else `$PULSE_RUNTIME_PATH/native`,
/// else `$XDG_RUNTIME_DIR/pulse/native`. `pipewire-pulse` listens on the last
/// one.
///
/// `Ok(None)`: no socket where libpulse would look, so no sound server runs
/// for this user, and only ALSA's default input is offered (#216). An error:
/// `$PULSE_SERVER` is set but names no local socket that exists (a TCP
/// server, a typo, a server that is gone). That is a configuration the user
/// made, and offering ALSA instead would hide it, so it is reported.
pub fn socket_path() -> Result<Option<PathBuf>> {
    server_socket(
        std::env::var("PULSE_SERVER").ok().as_deref(),
        std::env::var_os("PULSE_RUNTIME_PATH"),
        std::env::var_os("XDG_RUNTIME_DIR"),
        |path| path.exists(),
    )
}

fn server_socket(
    pulse_server: Option<&str>,
    runtime_path: Option<OsString>,
    xdg_runtime_dir: Option<OsString>,
    exists: impl Fn(&Path) -> bool,
) -> Result<Option<PathBuf>> {
    if let Some(servers) = pulse_server.filter(|servers| !servers.trim().is_empty()) {
        // A list of servers separated by spaces; only local sockets are used.
        let local: Vec<PathBuf> = servers.split_whitespace().filter_map(local_socket).collect();
        if let Some(path) = local.iter().find(|path| exists(path)) {
            return Ok(Some(path.clone()));
        }
        return Err(match local.first() {
            Some(path) => anyhow!("PULSE_SERVER is set to \"{servers}\", and {} does not exist", path.display()),
            None => anyhow!(
                "PULSE_SERVER is set to \"{servers}\", which names no local socket; Protocol reaches the sound server only through a local socket (unix:/path)"
            ),
        });
    }
    let Some(runtime) = runtime_path.map(PathBuf::from).or_else(|| xdg_runtime_dir.map(|dir| PathBuf::from(dir).join("pulse"))) else {
        return Ok(None);
    };
    Ok(Some(runtime.join("native")).filter(|path| exists(path)))
}

/// The socket path of one `$PULSE_SERVER` entry, if it is a local one:
/// `unix:/path` or `/path`, optionally after the `{machine-id}` libpulse
/// allows in front.
fn local_socket(server: &str) -> Option<PathBuf> {
    let server = match server.strip_prefix('{') {
        Some(rest) => rest.split_once('}')?.1,
        None => server,
    };
    let path = server.strip_prefix("unix:").unwrap_or(server);
    path.starts_with('/').then(|| PathBuf::from(path))
}

/// Where libpulse looks for the auth cookie, in its order: `$PULSE_COOKIE`,
/// `$XDG_CONFIG_HOME/pulse/cookie` (`~/.config` when the variable is unset
/// or not absolute, as the XDG spec says), then the old `~/.pulse-cookie`.
fn cookie_paths(pulse_cookie: Option<OsString>, config_home: Option<OsString>, home: Option<OsString>) -> Vec<PathBuf> {
    let home = home.filter(|home| !home.is_empty()).map(PathBuf::from);
    let config = config_home
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .or_else(|| home.as_ref().map(|home| home.join(".config")));
    pulse_cookie
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .into_iter()
        .chain(config.map(|dir| dir.join("pulse").join("cookie")))
        .chain(home.map(|home| home.join(".pulse-cookie")))
        .collect()
}

/// Which cookie an Auth sends, for the log. Never carries the bytes.
#[derive(Debug, PartialEq, Eq)]
enum Cookie {
    Found(PathBuf),
    Missing(Vec<PathBuf>),
    Unreadable(PathBuf, String),
    WrongLength(PathBuf, usize),
}

impl std::fmt::Display for Cookie {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Cookie::Found(path) => write!(f, "sending the cookie from {}", path.display()),
            Cookie::Missing(paths) => {
                let paths: Vec<_> = paths.iter().map(|path| path.display().to_string()).collect();
                write!(f, "no cookie at {}; sending zeros", paths.join(", "))
            }
            Cookie::Unreadable(path, error) => write!(f, "cannot read the cookie at {} ({error}); sending zeros", path.display()),
            Cookie::WrongLength(path, length) => {
                write!(f, "the cookie at {} is {length} bytes, not {COOKIE_LENGTH}; sending zeros", path.display())
            }
        }
    }
}

/// The cookie to send: the first file of `paths` that exists, as libpulse
/// takes it, if it has the right length. A user's own socket lets the user
/// in by its credentials, so the content rarely matters, but its length
/// does: `pipewire-pulse` refuses an Auth whose cookie is not 256 bytes
/// ("Invalid"), which an empty one was in a profile where no libpulse client
/// had made the file yet. Zeros stand in for a missing, unreadable or
/// malformed one.
fn choose_cookie(paths: &[PathBuf], read: impl Fn(&Path) -> std::io::Result<Vec<u8>>) -> (Vec<u8>, Cookie) {
    let zeros = || vec![0; COOKIE_LENGTH];
    for path in paths {
        match read(path) {
            Ok(bytes) if bytes.len() == COOKIE_LENGTH => return (bytes, Cookie::Found(path.clone())),
            Ok(bytes) => return (zeros(), Cookie::WrongLength(path.clone(), bytes.len())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return (zeros(), Cookie::Unreadable(path.clone(), error.to_string())),
        }
    }
    (zeros(), Cookie::Missing(paths.to_vec()))
}

/// The cookie case is logged for the first connection only: every listing
/// and record stream connects, and the case does not change in between.
static COOKIE_LOGGED: Once = Once::new();

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
        let path = socket_path()?.ok_or_else(|| anyhow!("no PipeWire or PulseAudio server is running"))?;
        let socket = UnixStream::connect(&path)
            .with_context(|| format!("cannot connect to the sound server at {}", path.display()))?;
        socket.set_read_timeout(Some(REPLY_TIMEOUT))?;
        socket.set_write_timeout(Some(REPLY_TIMEOUT))?;
        let mut connection = Self { reader: BufReader::new(socket), version: protocol::MAX_VERSION, next_seq: 0 };

        let paths = cookie_paths(std::env::var_os("PULSE_COOKIE"), std::env::var_os("XDG_CONFIG_HOME"), std::env::var_os("HOME"));
        let (cookie, case) = choose_cookie(&paths, |path| std::fs::read(path));
        COOKIE_LOGGED.call_once(|| log::info!("Sound server auth: {case}"));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn os(value: &str) -> Option<OsString> {
        Some(OsString::from(value))
    }

    #[test]
    fn the_runtime_socket_is_used_and_its_absence_means_no_server() {
        let exists = |path: &Path| path == Path::new("/run/user/1000/pulse/native");
        assert_eq!(server_socket(None, None, os("/run/user/1000"), exists).unwrap(), Some(PathBuf::from("/run/user/1000/pulse/native")));
        assert_eq!(server_socket(None, os("/tmp/pa"), os("/run/user/1000"), exists).unwrap(), None);
        assert_eq!(server_socket(None, None, None, exists).unwrap(), None);
        // Set but empty counts as unset.
        assert_eq!(server_socket(Some("  "), None, os("/run/user/1000"), exists).unwrap(), Some(PathBuf::from("/run/user/1000/pulse/native")));
    }

    #[test]
    fn pulse_server_takes_its_first_local_socket_that_exists() {
        let exists = |path: &Path| path == Path::new("/srv/pulse/native");
        let socket = server_socket(Some("tcp:media:4713 unix:/gone/native {0123abcd}unix:/srv/pulse/native"), None, None, exists);
        assert_eq!(socket.unwrap(), Some(PathBuf::from("/srv/pulse/native")));
    }

    #[test]
    fn a_pulse_server_without_a_usable_local_socket_is_an_error_naming_it() {
        // The runtime socket exists, but PULSE_SERVER says to use another server.
        let runtime = |path: &Path| path == Path::new("/run/user/1000/pulse/native");
        let tcp = server_socket(Some("tcp:media.local:4713"), None, os("/run/user/1000"), runtime).unwrap_err().to_string();
        assert!(tcp.contains("PULSE_SERVER is set to \"tcp:media.local:4713\""), "{tcp}");
        assert!(tcp.contains("names no local socket"), "{tcp}");
        let gone = server_socket(Some("unix:/tmp/old/native"), None, os("/run/user/1000"), runtime).unwrap_err().to_string();
        assert_eq!(gone, "PULSE_SERVER is set to \"unix:/tmp/old/native\", and /tmp/old/native does not exist");
    }

    #[test]
    fn the_cookie_is_looked_for_where_libpulse_looks() {
        assert_eq!(
            cookie_paths(os("/etc/pa-cookie"), os("/cfg"), os("/home/u")),
            [PathBuf::from("/etc/pa-cookie"), "/cfg/pulse/cookie".into(), "/home/u/.pulse-cookie".into()],
        );
        // XDG_CONFIG_HOME unset, empty or relative: ~/.config.
        for config in [None, os(""), os("relative/cfg")] {
            assert_eq!(cookie_paths(None, config, os("/home/u")), [PathBuf::from("/home/u/.config/pulse/cookie"), "/home/u/.pulse-cookie".into()]);
        }
        assert_eq!(cookie_paths(None, None, None), Vec::<PathBuf>::new());
    }

    #[test]
    fn each_cookie_case_is_named_and_only_a_whole_cookie_is_sent() {
        use std::io::{Error, ErrorKind};
        let paths = [PathBuf::from("/cfg/pulse/cookie"), PathBuf::from("/home/u/.pulse-cookie")];
        let cookie: Vec<u8> = (0..=255).collect();

        let found = choose_cookie(&paths, |path| if path.ends_with(".pulse-cookie") { Ok(cookie.clone()) } else { Err(ErrorKind::NotFound.into()) });
        assert_eq!(found, (cookie.clone(), Cookie::Found(paths[1].clone())));

        let missing = choose_cookie(&paths, |_| Err(ErrorKind::NotFound.into()));
        assert_eq!(missing, (vec![0; COOKIE_LENGTH], Cookie::Missing(paths.to_vec())));

        // The first file that exists decides, as in libpulse: a later one is not tried.
        let unreadable = choose_cookie(&paths, |path| {
            if path.ends_with("cookie") && !path.ends_with(".pulse-cookie") { Err(Error::new(ErrorKind::PermissionDenied, "denied")) } else { Ok(cookie.clone()) }
        });
        assert_eq!(unreadable, (vec![0; COOKIE_LENGTH], Cookie::Unreadable(paths[0].clone(), "denied".into())));

        let short = choose_cookie(&paths, |_| Ok(Vec::new()));
        assert_eq!(short, (vec![0; COOKIE_LENGTH], Cookie::WrongLength(paths[0].clone(), 0)));

        // What the log says carries no cookie bytes.
        assert_eq!(found.1.to_string(), "sending the cookie from /home/u/.pulse-cookie");
        assert_eq!(short.1.to_string(), "the cookie at /cfg/pulse/cookie is 0 bytes, not 256; sending zeros");
    }
}
