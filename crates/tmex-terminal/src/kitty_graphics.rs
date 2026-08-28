use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read, Write};

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use base64::Engine as _;
use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;

pub const KITTY_GRAPHICS_MAX_BYTES: usize = 16 * 1024 * 1024;
pub const KITTY_IMAGE_STORAGE_LIMIT: u64 = 64 * 1024 * 1024;
pub const KITTY_APC_MAX_BYTES: u64 = 16 * 1024 * 1024;
pub(crate) const KITTY_CONTROL_MAX_BYTES: usize = 4 * 1024;
pub(crate) const KITTY_BASE64_MAX_BYTES: usize =
    (KITTY_GRAPHICS_MAX_BYTES.saturating_add(2) / 3) * 4;

const KITTY_RGBA_MAX_BYTES: usize = KITTY_IMAGE_STORAGE_LIMIT as usize;

/// Remove complete Kitty graphics APC sequences (`ESC _ G ... ESC \\`) from a byte
/// stream. Other APC sequences and ordinary terminal bytes are kept. Incomplete
/// trailing `ESC _ G` is dropped so base64 never leaks into the text lane.
pub fn strip_kitty_graphics_sequences(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == 0x1b
            && index + 2 < bytes.len()
            && bytes[index + 1] == b'_'
            && bytes[index + 2] == b'G'
        {
            index += 3;
            while index < bytes.len() {
                if bytes[index] == 0x1b && index + 1 < bytes.len() && bytes[index + 1] == b'\\' {
                    index += 2;
                    break;
                }
                index += 1;
            }
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    out
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KittyGraphicsEvent {
    Reply(Vec<u8>),
    Error {
        image_id: Option<u32>,
        message: String,
    },
    ReplayImage {
        image_id: u32,
        virtual_placement: bool,
        width: u32,
        height: u32,
        format: u8,
        data: Vec<u8>,
    },
    ReplayPlacement {
        image_id: u32,
        placement_id: u32,
        src_x: u32,
        src_y: u32,
        src_width: u32,
        src_height: u32,
        columns: u16,
        rows: u16,
        x_offset: u16,
        y_offset: u16,
        z_index: i32,
        data: Vec<u8>,
    },
    ReplayDelete {
        image_id: Option<u32>,
    },
}

pub const KITTY_FORMAT_PNG: u8 = 100;
pub const KITTY_FORMAT_ZLIB: u8 = 122;
pub const KITTY_FORMAT_RAW: u8 = 0;

#[derive(Default)]
pub(crate) struct KittyGraphicsOutput {
    pub terminal_bytes: Vec<u8>,
    pub events: Vec<KittyGraphicsEvent>,
}

#[derive(Clone, Debug)]
enum PendingTransfer {
    Buffered {
        params: Vec<(String, String)>,
        encoded: Vec<u8>,
    },
    Direct {
        params: Vec<(String, String)>,
        encoded_bytes: usize,
        terminal_bytes: usize,
        replay: Option<Vec<u8>>,
    },
}

#[derive(Default)]
pub(crate) struct KittyGraphicsProcessor {
    pending: Option<PendingTransfer>,
    known_images: HashSet<u32>,
    /// 已下发过的图片内容指纹（image_id → (长度, FNV-1a)）：omp 等客户端每秒重发同一批
    /// 图片，字节不变时跳过 ReplayImage，避免上游按渲染频率重收整个像素负载。
    emitted_fingerprints: HashMap<u32, (usize, u64)>,
}

fn content_fingerprint(data: &[u8]) -> (usize, u64) {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in data {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    (data.len(), hash)
}

fn virtual_replay_placement(
    params: &[(String, String)],
    image_id: u32,
    data: Vec<u8>,
) -> Option<KittyGraphicsEvent> {
    (parameter_u8(params, "U") == Some(1)).then(|| KittyGraphicsEvent::ReplayPlacement {
        image_id,
        placement_id: parameter_u32(params, "p").unwrap_or(0),
        src_x: parameter_u32(params, "x").unwrap_or(0),
        src_y: parameter_u32(params, "y").unwrap_or(0),
        src_width: parameter_u32(params, "w").unwrap_or(0),
        src_height: parameter_u32(params, "h").unwrap_or(0),
        columns: parameter_u32(params, "c").unwrap_or(0) as u16,
        rows: parameter_u32(params, "r").unwrap_or(0) as u16,
        x_offset: parameter_u32(params, "X").unwrap_or(0) as u16,
        y_offset: parameter_u32(params, "Y").unwrap_or(0) as u16,
        z_index: parameter_i32(params, "z").unwrap_or(0),
        data,
    })
}

impl KittyGraphicsProcessor {
    pub fn reset(&mut self) {
        self.pending = None;
        self.known_images.clear();
        self.emitted_fingerprints.clear();
    }

    pub fn has_pending(&self) -> bool {
        self.pending.is_some()
    }

    pub fn abort_pending(&mut self, message: &str) -> KittyGraphicsOutput {
        let Some(pending) = self.pending.take() else {
            return KittyGraphicsOutput::default();
        };
        let params = match &pending {
            PendingTransfer::Buffered { params, .. } | PendingTransfer::Direct { params, .. } => {
                params
            }
        };
        let image_id = parameter_u32(params, "i").filter(|id| *id != 0);
        error_output(params, image_id, message)
    }

    pub fn reject(&mut self, control: &[u8], message: &str) -> KittyGraphicsOutput {
        if self.pending.is_some() {
            return self.abort_pending(message);
        }
        let control = String::from_utf8_lossy(control);
        let params = parse_parameters(&control);
        let image_id = parameter_u32(&params, "i").filter(|id| *id != 0);
        error_output(&params, image_id, message)
    }

    pub fn process(&mut self, control: &[u8], payload: &[u8]) -> KittyGraphicsOutput {
        let control = String::from_utf8_lossy(control);
        let params = parse_parameters(&control);
        let continuation = parameter_u8(&params, "m");

        if let Some(pending) = self.pending.take() {
            return match pending {
                PendingTransfer::Buffered {
                    params,
                    mut encoded,
                } => {
                    if encoded.len().saturating_add(payload.len()) > KITTY_BASE64_MAX_BYTES {
                        return error_output(
                            &params,
                            parameter_u32(&params, "i").filter(|id| *id != 0),
                            "Kitty graphics image exceeds the 16 MiB limit",
                        );
                    }
                    encoded.extend_from_slice(payload);
                    if continuation == Some(1) {
                        self.pending = Some(PendingTransfer::Buffered { params, encoded });
                        KittyGraphicsOutput::default()
                    } else {
                        self.process_complete(params, &encoded)
                    }
                }
                PendingTransfer::Direct {
                    params: initial_params,
                    encoded_bytes,
                    terminal_bytes,
                    replay,
                } => self.process_direct_chunk(
                    initial_params,
                    encoded_bytes,
                    terminal_bytes,
                    replay,
                    params,
                    payload,
                    continuation,
                ),
            };
        }

        if continuation == Some(1) {
            if payload.len() > KITTY_BASE64_MAX_BYTES {
                return error_output(
                    &params,
                    parameter_u32(&params, "i").filter(|id| *id != 0),
                    "Kitty graphics image exceeds the 16 MiB limit",
                );
            }
            if is_direct_transmission(&params) {
                if !valid_stream_base64_chunk(payload, false) {
                    return error_output(
                        &params,
                        parameter_u32(&params, "i").filter(|id| *id != 0),
                        "EINVAL: invalid Kitty graphics base64 payload",
                    );
                }
                let output = KittyGraphicsOutput {
                    terminal_bytes: Vec::new(),
                    events: Vec::new(),
                };
                let replay = is_replayable_image(&params).then(|| payload.to_vec());
                self.pending = Some(PendingTransfer::Direct {
                    params,
                    encoded_bytes: payload.len(),
                    terminal_bytes: output.terminal_bytes.len(),
                    replay,
                });
                return output;
            }
            self.pending = Some(PendingTransfer::Buffered {
                params,
                encoded: payload.to_vec(),
            });
            return KittyGraphicsOutput::default();
        }

        self.process_complete(params, payload)
    }

    fn process_direct_chunk(
        &mut self,
        initial_params: Vec<(String, String)>,
        encoded_bytes: usize,
        terminal_bytes: usize,
        mut replay: Option<Vec<u8>>,
        _params: Vec<(String, String)>,
        payload: &[u8],
        continuation: Option<u8>,
    ) -> KittyGraphicsOutput {
        let final_chunk = continuation != Some(1);
        if !valid_stream_base64_chunk(payload, final_chunk) {
            return error_output(
                &initial_params,
                parameter_u32(&initial_params, "i").filter(|id| *id != 0),
                "EINVAL: invalid Kitty graphics base64 payload",
            );
        }
        let encoded_bytes = encoded_bytes.saturating_add(payload.len());
        if encoded_bytes > KITTY_BASE64_MAX_BYTES {
            return error_output(
                &initial_params,
                parameter_u32(&initial_params, "i").filter(|id| *id != 0),
                "Kitty graphics image exceeds the 16 MiB limit",
            );
        }

        let mut output = KittyGraphicsOutput {
            terminal_bytes: Vec::new(),
            events: Vec::new(),
        };
        if let Some(bytes) = &mut replay {
            bytes.extend_from_slice(payload);
        }
        let terminal_bytes = terminal_bytes.saturating_add(output.terminal_bytes.len());
        if !final_chunk {
            self.pending = Some(PendingTransfer::Direct {
                params: initial_params,
                encoded_bytes,
                terminal_bytes,
                replay,
            });
            return output;
        }
        let padding = payload
            .iter()
            .rev()
            .take_while(|byte| **byte == b'=')
            .count();
        let Some(decoded_bytes) = decoded_base64_len(encoded_bytes, padding) else {
            return error_output(
                &initial_params,
                parameter_u32(&initial_params, "i").filter(|id| *id != 0),
                "EINVAL: invalid Kitty graphics base64 payload",
            );
        };
        if decoded_bytes > KITTY_GRAPHICS_MAX_BYTES {
            return error_output(
                &initial_params,
                parameter_u32(&initial_params, "i").filter(|id| *id != 0),
                "Kitty graphics image exceeds the 16 MiB limit",
            );
        }

        let action = parameter(&initial_params, "a")
            .and_then(|value| value.as_bytes().first().copied())
            .unwrap_or(b't');
        let image_id = parameter_u32(&initial_params, "i").filter(|id| *id != 0);
        let placement_id = parameter_u32(&initial_params, "p").filter(|id| *id != 0);
        let quiet = parameter_u8(&initial_params, "q").unwrap_or(0);
        if let Some(id) = image_id {
            self.known_images.insert(id);
            if quiet == 0 {
                output.events.push(KittyGraphicsEvent::Reply(reply_bytes(
                    Some(id),
                    placement_id,
                    "OK",
                )));
            }
        }
        if let (Some(id), Some(encoded)) = (image_id, replay) {
            if let Ok(data) = decode_base64(&encoded) {
                let fingerprint = content_fingerprint(&data);
                if self.emitted_fingerprints.get(&id) != Some(&fingerprint) {
                    let format_code = parameter_u32(&initial_params, "f").unwrap_or(32);
                    let compression = parameter(&initial_params, "o");
                    let format = if format_code == 100 {
                        KITTY_FORMAT_PNG
                    } else if compression == Some("z") {
                        KITTY_FORMAT_ZLIB
                    } else {
                        KITTY_FORMAT_RAW
                    };
                    output.events.push(KittyGraphicsEvent::ReplayImage {
                        image_id: id,
                        virtual_placement: parameter_u8(&initial_params, "U") == Some(1),
                        width: parameter_u32(&initial_params, "s").unwrap_or(0),
                        height: parameter_u32(&initial_params, "v").unwrap_or(0),
                        format,
                        data,
                    });
                    self.emitted_fingerprints.insert(id, fingerprint);
                }
            }
        }
        if let Some(placement) =
            image_id.and_then(|id| virtual_replay_placement(&initial_params, id, Vec::new()))
        {
            output.events.push(placement);
        }
        tracing::info!(
            target: "tmex_terminal::kitty_graphics",
            stage = "gateway_emit",
            action = %char::from(action),
            image_id = image_id.unwrap_or(0),
            source_format = parameter_u32(&initial_params, "f").unwrap_or(32),
            encoded_bytes,
            payload_bytes = decoded_bytes,
            terminal_bytes,
            width = parameter_u32(&initial_params, "s").unwrap_or(0),
            height = parameter_u32(&initial_params, "v").unwrap_or(0),
            virtual_placement = parameter_u8(&initial_params, "U") == Some(1),
            streamed = true,
            "Kitty graphics payload emitted"
        );
        output
    }

    fn process_complete(
        &mut self,
        mut params: Vec<(String, String)>,
        encoded: &[u8],
    ) -> KittyGraphicsOutput {
        remove_parameter(&mut params, "m");
        let action = parameter(&params, "a").and_then(|value| value.as_bytes().first().copied());
        let action = action.unwrap_or(b't');
        let medium = parameter(&params, "t").and_then(|value| value.as_bytes().first().copied());
        let medium = medium.unwrap_or(b'd');
        let image_id = parameter_u32(&params, "i").filter(|id| *id != 0);
        let placement_id = parameter_u32(&params, "p").filter(|id| *id != 0);
        let quiet = parameter_u8(&params, "q").unwrap_or(0);

        if action == b'q' {
            if medium != b'd' {
                return reply_only(
                    &params,
                    image_id,
                    placement_id,
                    quiet,
                    false,
                    "ENOTSUP: transmission medium is not available",
                );
            }
            let decoded = match decode_base64(encoded) {
                Ok(decoded) => decoded,
                Err(message) => {
                    return reply_only(&params, image_id, placement_id, quiet, false, &message)
                }
            };
            if decoded.len() > KITTY_GRAPHICS_MAX_BYTES {
                return error_output(
                    &params,
                    image_id,
                    "Kitty graphics image exceeds the 16 MiB limit",
                );
            }
            return reply_only(&params, image_id, placement_id, quiet, true, "OK");
        }

        if medium != b'd' {
            return reply_only(
                &params,
                image_id,
                placement_id,
                quiet,
                false,
                "ENOTSUP: transmission medium is not available",
            );
        }

        if matches!(action, b't' | b'T' | b'f') {
            let mut decoded = match decode_base64(encoded) {
                Ok(decoded) => decoded,
                Err(message) => return error_output(&params, image_id, &message),
            };
            if decoded.len() > KITTY_GRAPHICS_MAX_BYTES {
                return error_output(
                    &params,
                    image_id,
                    "Kitty graphics image exceeds the 16 MiB limit",
                );
            }

            let source_format = parameter_u32(&params, "f").unwrap_or(32);
            if source_format == 100 && parameter(&params, "o") == Some("z") {
                decoded = match decode_zlib_limited(&decoded, KITTY_GRAPHICS_MAX_BYTES) {
                    Ok(decoded) => decoded,
                    Err(message) => return error_output(&params, image_id, &message),
                };
            }
            let fingerprint = content_fingerprint(&decoded);
            let unchanged =
                image_id.is_some_and(|id| self.emitted_fingerprints.get(&id) == Some(&fingerprint));
            let mut output = KittyGraphicsOutput {
                terminal_bytes: Vec::new(),
                events: Vec::new(),
            };
            if let Some(id) = image_id {
                self.known_images.insert(id);
                if quiet == 0 {
                    output.events.push(KittyGraphicsEvent::Reply(reply_bytes(
                        Some(id),
                        placement_id,
                        "OK",
                    )));
                }
                if unchanged {
                    if let Some(placement) = virtual_replay_placement(&params, id, Vec::new()) {
                        output.events.push(placement);
                    }
                    return output;
                }
            }

            let (width, height, format) = if source_format == 100 {
                let (width, height) = match png_dimensions(&decoded) {
                    Ok(dimensions) => dimensions,
                    Err(message) => return error_output(&params, image_id, &message),
                };
                (width, height, KITTY_FORMAT_PNG)
            } else {
                let format = if parameter(&params, "o") == Some("z") {
                    KITTY_FORMAT_ZLIB
                } else {
                    KITTY_FORMAT_RAW
                };
                (
                    parameter_u32(&params, "s").unwrap_or(0),
                    parameter_u32(&params, "v").unwrap_or(0),
                    format,
                )
            };
            if let Some(id) = image_id {
                output.events.push(KittyGraphicsEvent::ReplayImage {
                    image_id: id,
                    virtual_placement: parameter_u8(&params, "U") == Some(1),
                    width,
                    height,
                    format,
                    data: decoded.clone(),
                });
                self.emitted_fingerprints.insert(id, fingerprint);
                if let Some(placement) = virtual_replay_placement(&params, id, Vec::new()) {
                    output.events.push(placement);
                }
            }
            tracing::info!(
                target: "tmex_terminal::kitty_graphics",
                stage = "gateway_emit",
                action = %char::from(action),
                image_id = image_id.unwrap_or(0),
                source_format,
                encoded_bytes = encoded.len(),
                payload_bytes = decoded.len(),
                terminal_bytes = output.terminal_bytes.len(),
                width,
                height,
                virtual_placement = parameter_u8(&params, "U") == Some(1),
                "Kitty graphics payload emitted"
            );
            return output;
        }

        let mut output = KittyGraphicsOutput {
            terminal_bytes: encode_apc(&params, encoded),
            events: Vec::new(),
        };

        if action == b'p' {
            if let Some(id) = image_id {
                let known = self.known_images.contains(&id);
                if known && quiet == 0 {
                    output.events.push(KittyGraphicsEvent::Reply(reply_bytes(
                        Some(id),
                        placement_id,
                        "OK",
                    )));
                } else if !known && quiet < 2 {
                    output.events.push(KittyGraphicsEvent::Reply(reply_bytes(
                        Some(id),
                        placement_id,
                        "ENOENT: image id was not found",
                    )));
                }
                if let Some(placement) =
                    virtual_replay_placement(&params, id, output.terminal_bytes.clone())
                {
                    output.events.push(placement);
                }
            }
        } else if action == b'd' {
            match parameter(&params, "d") {
                Some("A") => self.known_images.clear(),
                Some("i" | "I") => {
                    if let Some(id) = image_id {
                        self.known_images.remove(&id);
                        output
                            .events
                            .push(KittyGraphicsEvent::ReplayDelete { image_id: Some(id) });
                    }
                }
                Some("r" | "R" | "n" | "N") => {
                    output
                        .events
                        .push(KittyGraphicsEvent::ReplayDelete { image_id: None });
                }
                _ => {}
            }
        }

        output
    }
}
fn is_direct_transmission(params: &[(String, String)]) -> bool {
    let action = parameter(params, "a")
        .and_then(|value| value.as_bytes().first().copied())
        .unwrap_or(b't');
    let medium = parameter(params, "t")
        .and_then(|value| value.as_bytes().first().copied())
        .unwrap_or(b'd');
    matches!(action, b't' | b'T' | b'f')
        && medium == b'd'
        && parameter_u32(params, "f").unwrap_or(32) != 100
}

fn is_replayable_image(params: &[(String, String)]) -> bool {
    parameter_u32(params, "i").is_some_and(|id| id != 0)
}

fn valid_stream_base64_chunk(payload: &[u8], final_chunk: bool) -> bool {
    let mut padding = 0;
    for byte in payload {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/') {
            if padding != 0 {
                return false;
            }
        } else if *byte == b'=' && final_chunk {
            padding += 1;
            if padding > 2 {
                return false;
            }
        } else {
            return false;
        }
    }
    true
}

fn decoded_base64_len(encoded_bytes: usize, padding: usize) -> Option<usize> {
    if padding > 2 || padding > encoded_bytes {
        return None;
    }
    if padding != 0 {
        return (encoded_bytes % 4 == 0)
            .then(|| encoded_bytes / 4 * 3)
            .and_then(|length| length.checked_sub(padding));
    }
    let complete = encoded_bytes / 4 * 3;
    match encoded_bytes % 4 {
        0 => Some(complete),
        2 => complete.checked_add(1),
        3 => complete.checked_add(2),
        _ => None,
    }
}

fn parse_parameters(control: &str) -> Vec<(String, String)> {
    control
        .split(',')
        .filter_map(|entry| {
            let (key, value) = entry.split_once('=')?;
            (!key.is_empty()).then(|| (key.to_owned(), value.to_owned()))
        })
        .collect()
}

fn parameter<'a>(params: &'a [(String, String)], key: &str) -> Option<&'a str> {
    params
        .iter()
        .rev()
        .find_map(|(candidate, value)| (candidate == key).then_some(value.as_str()))
}

fn parameter_u32(params: &[(String, String)], key: &str) -> Option<u32> {
    parameter(params, key)?.parse().ok()
}

fn parameter_u8(params: &[(String, String)], key: &str) -> Option<u8> {
    parameter(params, key)?.parse().ok()
}

fn parameter_i32(params: &[(String, String)], key: &str) -> Option<i32> {
    parameter(params, key)?.parse().ok()
}

fn remove_parameter(params: &mut Vec<(String, String)>, key: &str) {
    params.retain(|(candidate, _)| candidate != key);
}

fn decode_base64(encoded: &[u8]) -> Result<Vec<u8>, String> {
    if encoded.len() > KITTY_BASE64_MAX_BYTES {
        return Err("Kitty graphics image exceeds the 16 MiB limit".to_owned());
    }
    STANDARD
        .decode(encoded)
        .or_else(|_| STANDARD_NO_PAD.decode(encoded))
        .map_err(|_| "EINVAL: invalid Kitty graphics base64 payload".to_owned())
}

fn decode_zlib_limited(data: &[u8], limit: usize) -> Result<Vec<u8>, String> {
    let mut decoder = ZlibDecoder::new(Cursor::new(data));
    let mut decoded = Vec::new();
    decoder
        .by_ref()
        .take(u64::try_from(limit).unwrap_or(u64::MAX).saturating_add(1))
        .read_to_end(&mut decoded)
        .map_err(|error| format!("EINVAL: invalid zlib payload: {error}"))?;
    if decoded.len() > limit {
        return Err("Kitty graphics image exceeds the 16 MiB limit".to_owned());
    }
    Ok(decoded)
}

fn encode_zlib(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(data)
        .map_err(|error| format!("EIO: failed to compress Kitty graphics pixels: {error}"))?;
    encoder
        .finish()
        .map_err(|error| format!("EIO: failed to finish Kitty graphics compression: {error}"))
}

pub fn prepare_kitty_replay_payload(format: u8, data: Vec<u8>) -> (u8, Vec<u8>) {
    if format != KITTY_FORMAT_RAW || data.is_empty() {
        return (format, data);
    }
    match encode_zlib(&data) {
        Ok(compressed) if compressed.len() <= KITTY_GRAPHICS_MAX_BYTES => {
            (KITTY_FORMAT_ZLIB, compressed)
        }
        _ => (format, data),
    }
}

fn png_dimensions(data: &[u8]) -> Result<(u32, u32), String> {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if data.len() < 24
        || data.get(..8) != Some(PNG_SIGNATURE)
        || data.get(8..12) != Some(&13u32.to_be_bytes())
        || data.get(12..16) != Some(b"IHDR")
    {
        return Err("EINVAL: invalid PNG header".to_owned());
    }
    let width = u32::from_be_bytes(
        data[16..20]
            .try_into()
            .map_err(|_| "EINVAL: invalid PNG width".to_owned())?,
    );
    let height = u32::from_be_bytes(
        data[20..24]
            .try_into()
            .map_err(|_| "EINVAL: invalid PNG height".to_owned())?,
    );
    let rgba_len = usize::try_from(width)
        .ok()
        .and_then(|width| {
            usize::try_from(height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "EOVERFLOW: PNG RGBA size is too large".to_owned())?;
    if width == 0 || height == 0 || rgba_len > KITTY_RGBA_MAX_BYTES {
        return Err("Kitty graphics decoded image exceeds the 64 MiB storage limit".to_owned());
    }
    Ok((width, height))
}

fn encode_apc(params: &[(String, String)], payload: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"\x1b_G");
    for (index, (key, value)) in params.iter().enumerate() {
        if index > 0 {
            bytes.push(b',');
        }
        bytes.extend_from_slice(key.as_bytes());
        bytes.push(b'=');
        bytes.extend_from_slice(value.as_bytes());
    }
    bytes.push(b';');
    bytes.extend_from_slice(payload);
    bytes.extend_from_slice(b"\x1b\\");
    bytes
}

fn reply_only(
    params: &[(String, String)],
    image_id: Option<u32>,
    placement_id: Option<u32>,
    quiet: u8,
    success: bool,
    message: &str,
) -> KittyGraphicsOutput {
    let mut output = KittyGraphicsOutput::default();
    let should_reply = image_id.is_some() && if success { quiet == 0 } else { quiet < 2 };
    if should_reply {
        output.events.push(KittyGraphicsEvent::Reply(reply_bytes(
            image_id,
            placement_id,
            message,
        )));
    }
    if !success && quiet < 2 && parameter(params, "a") != Some("q") {
        output.events.push(KittyGraphicsEvent::Error {
            image_id,
            message: message.to_owned(),
        });
    }
    output
}

fn error_output(
    params: &[(String, String)],
    image_id: Option<u32>,
    message: &str,
) -> KittyGraphicsOutput {
    let quiet = parameter_u8(params, "q").unwrap_or(0);
    let placement_id = parameter_u32(params, "p").filter(|id| *id != 0);
    let mut output = KittyGraphicsOutput::default();
    if image_id.is_some() && quiet < 2 {
        output.events.push(KittyGraphicsEvent::Reply(reply_bytes(
            image_id,
            placement_id,
            message,
        )));
    }
    output.events.push(KittyGraphicsEvent::Error {
        image_id,
        message: message.to_owned(),
    });
    output
}

fn reply_bytes(image_id: Option<u32>, placement_id: Option<u32>, message: &str) -> Vec<u8> {
    let mut bytes = b"\x1b_G".to_vec();
    if let Some(id) = image_id {
        bytes.extend_from_slice(format!("i={id}").as_bytes());
    }
    if let Some(id) = placement_id {
        if image_id.is_some() {
            bytes.push(b',');
        }
        bytes.extend_from_slice(format!("p={id}").as_bytes());
    }
    bytes.push(b';');
    bytes.extend_from_slice(message.as_bytes());
    bytes.extend_from_slice(b"\x1b\\");
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny_rgba_png() -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 1, 1);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let Ok(mut writer) = encoder.write_header() else {
                return Vec::new();
            };
            if writer.write_image_data(&[255, 0, 0, 255]).is_err() {
                return Vec::new();
            }
        }
        bytes
    }

    #[test]
    fn passes_png_without_pixel_transcode_and_emits_virtual_placement() {
        let mut processor = KittyGraphicsProcessor::default();
        let png = tiny_rgba_png();
        let payload = STANDARD.encode(&png);
        let output = processor.process(b"a=T,f=100,i=7,U=1,c=4,r=3", payload.as_bytes());
        assert!(output.terminal_bytes.is_empty());
        assert!(output
            .events
            .contains(&KittyGraphicsEvent::Reply(b"\x1b_Gi=7;OK\x1b\\".to_vec())));
        assert!(output.events.contains(&KittyGraphicsEvent::ReplayImage {
            image_id: 7,
            virtual_placement: true,
            width: 1,
            height: 1,
            format: KITTY_FORMAT_PNG,
            data: png,
        }));
        assert!(output
            .events
            .contains(&KittyGraphicsEvent::ReplayPlacement {
                image_id: 7,
                placement_id: 0,
                src_x: 0,
                src_y: 0,
                src_width: 0,
                src_height: 0,
                columns: 4,
                rows: 3,
                x_offset: 0,
                y_offset: 0,
                z_index: 0,
                data: Vec::new(),
            }));
    }

    #[test]
    fn streams_direct_chunks_and_rejects_oversize_before_forwarding() {
        let mut processor = KittyGraphicsProcessor::default();
        let first = processor.process(b"a=T,q=2,f=32,i=3,m=1", b"AAAA");
        assert!(first.terminal_bytes.is_empty());
        assert!(first.events.is_empty());
        let final_chunk = processor.process(b"a=T,q=2", b"AAAA");
        assert!(final_chunk.terminal_bytes.is_empty());
        assert!(matches!(
            final_chunk.events.as_slice(),
            [KittyGraphicsEvent::ReplayImage {
                image_id: 3,
                virtual_placement: false,
                ..
            }]
        ));
        assert!(!processor.has_pending());

        let mut processor = KittyGraphicsProcessor::default();
        let oversized = vec![b'A'; KITTY_BASE64_MAX_BYTES + 1];
        let output = processor.process(b"a=T,f=32,i=3,m=1", &oversized);
        assert!(output.terminal_bytes.is_empty());
        assert!(output.events.iter().any(|event| matches!(
            event,
            KittyGraphicsEvent::Error {
                image_id: Some(3),
                ..
            }
        )));
    }

    #[test]
    fn virtual_direct_stream_emits_one_complete_replay_and_delete_event() {
        let mut processor = KittyGraphicsProcessor::default();
        let first = processor.process(b"a=T,q=2,f=32,U=1,c=2,r=3,i=3,m=1", b"AAAA");
        assert!(first.events.is_empty());
        let final_chunk = processor.process(b"a=T,q=2", b"AAAA");
        let decoded = STANDARD.decode(b"AAAAAAAA").expect("direct stream payload");
        assert_eq!(
            final_chunk.events,
            vec![
                KittyGraphicsEvent::ReplayImage {
                    image_id: 3,
                    virtual_placement: true,
                    width: 0,
                    height: 0,
                    format: KITTY_FORMAT_RAW,
                    data: decoded,
                },
                KittyGraphicsEvent::ReplayPlacement {
                    image_id: 3,
                    placement_id: 0,
                    src_x: 0,
                    src_y: 0,
                    src_width: 0,
                    src_height: 0,
                    columns: 2,
                    rows: 3,
                    x_offset: 0,
                    y_offset: 0,
                    z_index: 0,
                    data: Vec::new(),
                },
            ]
        );

        let deleted = processor.process(b"a=d,d=I,i=3,q=2", b"");
        assert!(deleted
            .events
            .contains(&KittyGraphicsEvent::ReplayDelete { image_id: Some(3) }));
    }

    #[test]
    fn separate_virtual_placement_replays_after_its_image() {
        let mut processor = KittyGraphicsProcessor::default();
        let image = processor.process(b"a=t,q=2,f=32,i=9", b"/wAA/w==");
        assert!(image.events.contains(&KittyGraphicsEvent::ReplayImage {
            image_id: 9,
            virtual_placement: false,
            width: 0,
            height: 0,
            format: KITTY_FORMAT_RAW,
            data: STANDARD.decode(b"/wAA/w==").expect("raw rgba"),
        }));
        let placement = processor.process(b"a=p,q=2,U=1,i=9,p=4,c=1,r=1,C=1", b"");
        assert!(placement
            .events
            .contains(&KittyGraphicsEvent::ReplayPlacement {
                image_id: 9,
                placement_id: 4,
                src_x: 0,
                src_y: 0,
                src_width: 0,
                src_height: 0,
                columns: 1,
                rows: 1,
                x_offset: 0,
                y_offset: 0,
                z_index: 0,
                data: placement.terminal_bytes.clone(),
            }));
    }

    #[test]
    fn query_reports_direct_and_rejects_file_medium_without_user_error() {
        let mut processor = KittyGraphicsProcessor::default();
        let direct = processor.process(b"a=q,t=d,f=24,s=1,v=1,i=31", b"AAAA");
        assert_eq!(
            direct.events,
            vec![KittyGraphicsEvent::Reply(b"\x1b_Gi=31;OK\x1b\\".to_vec())]
        );

        let file = processor.process(b"a=q,t=f,f=100,i=32", b"L3RtcC9pbWcucG5n");
        assert_eq!(file.events.len(), 1);
        assert!(matches!(file.events[0], KittyGraphicsEvent::Reply(_)));
        assert!(file.terminal_bytes.is_empty());
    }

    #[test]
    fn strip_kitty_graphics_sequences_drops_complete_apc_and_keeps_text() {
        let mixed = b"hello\x1b_Ga=T,f=32,i=1;AAAA\x1b\\world\x1b_custom\x1b\\";
        assert_eq!(
            strip_kitty_graphics_sequences(mixed),
            b"helloworld\x1b_custom\x1b\\"
        );
        assert!(strip_kitty_graphics_sequences(b"\x1b_Ga=T,i=1;AAAA\x1b\\").is_empty());
        assert_eq!(
            strip_kitty_graphics_sequences(b"keep\x1b_Ga=T,i=1;no-st"),
            b"keep"
        );
    }
}
