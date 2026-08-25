use std::collections::HashSet;
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

const KITTY_CHUNK_BYTES: usize = 4 * 1024;
const KITTY_RGBA_MAX_BYTES: usize = KITTY_IMAGE_STORAGE_LIMIT as usize;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KittyGraphicsEvent {
    Reply(Vec<u8>),
    Error {
        image_id: Option<u32>,
        message: String,
    },
}

#[derive(Default)]
pub(crate) struct KittyGraphicsOutput {
    pub terminal_bytes: Vec<u8>,
    pub events: Vec<KittyGraphicsEvent>,
}

#[derive(Clone, Debug)]
struct PendingTransfer {
    params: Vec<(String, String)>,
    encoded: Vec<u8>,
}

#[derive(Default)]
pub(crate) struct KittyGraphicsProcessor {
    pending: Option<PendingTransfer>,
    known_images: HashSet<u32>,
}

impl KittyGraphicsProcessor {
    pub fn reset(&mut self) {
        self.pending = None;
        self.known_images.clear();
    }

    pub fn has_pending(&self) -> bool {
        self.pending.is_some()
    }

    pub fn abort_pending(&mut self, message: &str) -> KittyGraphicsOutput {
        let Some(pending) = self.pending.take() else {
            return KittyGraphicsOutput::default();
        };
        let image_id = parameter_u32(&pending.params, "i").filter(|id| *id != 0);
        error_output(&pending.params, image_id, message)
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

        if let Some(mut pending) = self.pending.take() {
            if continuation.is_none() {
                let mut output = error_output(
                    &pending.params,
                    parameter_u32(&pending.params, "i").filter(|id| *id != 0),
                    "Kitty graphics transfer was interrupted",
                );
                output.append(self.process_complete(params, payload));
                return output;
            }
            if pending.encoded.len().saturating_add(payload.len()) > KITTY_BASE64_MAX_BYTES {
                return error_output(
                    &pending.params,
                    parameter_u32(&pending.params, "i").filter(|id| *id != 0),
                    "Kitty graphics image exceeds the 16 MiB limit",
                );
            }
            pending.encoded.extend_from_slice(payload);
            if continuation == Some(1) {
                self.pending = Some(pending);
                return KittyGraphicsOutput::default();
            }
            return self.process_complete(pending.params, &pending.encoded);
        }

        if continuation == Some(1) {
            if payload.len() > KITTY_BASE64_MAX_BYTES {
                return error_output(
                    &params,
                    parameter_u32(&params, "i").filter(|id| *id != 0),
                    "Kitty graphics image exceeds the 16 MiB limit",
                );
            }
            self.pending = Some(PendingTransfer {
                params,
                encoded: payload.to_vec(),
            });
            return KittyGraphicsOutput::default();
        }

        self.process_complete(params, payload)
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
                    return reply_only(
                        &params,
                        image_id,
                        placement_id,
                        quiet,
                        false,
                        &message,
                    )
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

            let format = parameter_u32(&params, "f").unwrap_or(32);
            if format == 100 {
                if parameter(&params, "o") == Some("z") {
                    decoded = match decode_zlib_limited(&decoded, KITTY_GRAPHICS_MAX_BYTES) {
                        Ok(decoded) => decoded,
                        Err(message) => return error_output(&params, image_id, &message),
                    };
                }
                let (width, height, rgba) = match decode_png_rgba(&decoded) {
                    Ok(image) => image,
                    Err(message) => return error_output(&params, image_id, &message),
                };
                let compressed = match encode_zlib(&rgba) {
                    Ok(compressed) => compressed,
                    Err(message) => return error_output(&params, image_id, &message),
                };
                if compressed.len() > KITTY_GRAPHICS_MAX_BYTES {
                    return error_output(
                        &params,
                        image_id,
                        "Kitty graphics image exceeds the 16 MiB encoded limit",
                    );
                }
                set_parameter(&mut params, "f", "32".to_owned());
                set_parameter(&mut params, "s", width.to_string());
                set_parameter(&mut params, "v", height.to_string());
                set_parameter(&mut params, "o", "z".to_owned());
                remove_parameter(&mut params, "S");
                remove_parameter(&mut params, "O");
                decoded = compressed;
            }

            let mut output = KittyGraphicsOutput {
                terminal_bytes: encode_direct_chunks(&params, &decoded),
                events: Vec::new(),
            };
            if let Some(id) = image_id {
                self.known_images.insert(id);
                if quiet == 0 {
                    output
                        .events
                        .push(KittyGraphicsEvent::Reply(reply_bytes(Some(id), placement_id, "OK")));
                }
            }
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
                    output
                        .events
                        .push(KittyGraphicsEvent::Reply(reply_bytes(Some(id), placement_id, "OK")));
                } else if !known && quiet < 2 {
                    output.events.push(KittyGraphicsEvent::Reply(reply_bytes(
                        Some(id),
                        placement_id,
                        "ENOENT: image id was not found",
                    )));
                }
            }
        } else if action == b'd' {
            match parameter(&params, "d") {
                Some("A") => self.known_images.clear(),
                Some("I") => {
                    if let Some(id) = image_id {
                        self.known_images.remove(&id);
                    }
                }
                _ => {}
            }
        }

        output
    }
}

impl KittyGraphicsOutput {
    fn append(&mut self, mut other: Self) {
        self.terminal_bytes.append(&mut other.terminal_bytes);
        self.events.append(&mut other.events);
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

fn set_parameter(params: &mut Vec<(String, String)>, key: &str, value: String) {
    if let Some((_, current)) = params.iter_mut().find(|(candidate, _)| candidate == key) {
        *current = value;
    } else {
        params.push((key.to_owned(), value));
    }
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

fn decode_png_rgba(data: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    let mut decoder = png::Decoder::new(Cursor::new(data));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder
        .read_info()
        .map_err(|error| format!("EINVAL: invalid PNG: {error}"))?;
    let output_size = reader
        .output_buffer_size()
        .ok_or_else(|| "EOVERFLOW: PNG output size is not representable".to_owned())?;
    if output_size > KITTY_RGBA_MAX_BYTES {
        return Err("Kitty graphics decoded image exceeds the 64 MiB storage limit".to_owned());
    }
    let mut buffer = vec![0; output_size];
    let info = reader
        .next_frame(&mut buffer)
        .map_err(|error| format!("EINVAL: invalid PNG frame: {error}"))?;
    let source = buffer
        .get(..info.buffer_size())
        .ok_or_else(|| "EINVAL: PNG decoder returned an invalid buffer size".to_owned())?;
    let pixel_count = usize::try_from(info.width)
        .ok()
        .and_then(|width| {
            usize::try_from(info.height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .ok_or_else(|| "EOVERFLOW: PNG dimensions are too large".to_owned())?;
    let rgba_len = pixel_count
        .checked_mul(4)
        .ok_or_else(|| "EOVERFLOW: PNG RGBA size is too large".to_owned())?;
    if rgba_len > KITTY_RGBA_MAX_BYTES {
        return Err("Kitty graphics decoded image exceeds the 64 MiB storage limit".to_owned());
    }

    let mut rgba = Vec::with_capacity(rgba_len);
    match info.color_type {
        png::ColorType::Rgba => rgba.extend_from_slice(source),
        png::ColorType::Rgb => {
            for pixel in source.chunks_exact(3) {
                rgba.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]);
            }
        }
        png::ColorType::GrayscaleAlpha => {
            for pixel in source.chunks_exact(2) {
                rgba.extend_from_slice(&[pixel[0], pixel[0], pixel[0], pixel[1]]);
            }
        }
        png::ColorType::Grayscale => {
            for value in source {
                rgba.extend_from_slice(&[*value, *value, *value, 255]);
            }
        }
        png::ColorType::Indexed => {
            return Err("EINVAL: PNG palette expansion was not applied".to_owned())
        }
    }
    if rgba.len() != rgba_len {
        return Err("EINVAL: PNG pixel data length does not match its dimensions".to_owned());
    }
    Ok((info.width, info.height, rgba))
}

fn encode_direct_chunks(params: &[(String, String)], data: &[u8]) -> Vec<u8> {
    let encoded = STANDARD.encode(data);
    if encoded.len() <= KITTY_CHUNK_BYTES {
        return encode_apc(params, encoded.as_bytes());
    }

    let chunks = encoded.as_bytes().chunks(KITTY_CHUNK_BYTES).collect::<Vec<_>>();
    let mut bytes = Vec::with_capacity(encoded.len().saturating_add(chunks.len() * 16));
    for (index, chunk) in chunks.iter().enumerate() {
        let more = index + 1 < chunks.len();
        if index == 0 {
            let mut first = params.to_vec();
            set_parameter(&mut first, "m", if more { "1" } else { "0" }.to_owned());
            bytes.extend_from_slice(&encode_apc(&first, chunk));
        } else {
            bytes.extend_from_slice(b"\x1b_Gm=");
            bytes.push(if more { b'1' } else { b'0' });
            bytes.push(b';');
            bytes.extend_from_slice(chunk);
            bytes.extend_from_slice(b"\x1b\\");
        }
    }
    bytes
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
    fn transcodes_png_to_chunkable_rgba_zlib() {
        let mut processor = KittyGraphicsProcessor::default();
        let payload = STANDARD.encode(tiny_rgba_png());
        let output = processor.process(b"a=T,f=100,i=7", payload.as_bytes());
        assert!(output.terminal_bytes.starts_with(b"\x1b_Ga=T,f=32,i=7,s=1,v=1,o=z"));
        let separator = output
            .terminal_bytes
            .iter()
            .position(|byte| *byte == b';')
            .expect("graphics separator");
        let encoded = &output.terminal_bytes[separator + 1..output.terminal_bytes.len() - 2];
        let compressed = STANDARD.decode(encoded).expect("decode rewritten payload");
        assert_eq!(
            decode_zlib_limited(&compressed, 4).expect("inflate rewritten RGBA"),
            [255, 0, 0, 255]
        );
        assert!(output
            .events
            .contains(&KittyGraphicsEvent::Reply(b"\x1b_Gi=7;OK\x1b\\".to_vec())));
    }

    #[test]
    fn aggregates_chunks_and_rejects_oversize_without_terminal_bytes() {
        let mut processor = KittyGraphicsProcessor::default();
        let first = processor.process(b"a=T,f=32,i=3,m=1", b"AAAA");
        assert!(first.terminal_bytes.is_empty());
        assert!(first.events.is_empty());

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
    fn query_reports_direct_and_rejects_file_medium_without_user_error() {
        let mut processor = KittyGraphicsProcessor::default();
        let direct = processor.process(b"a=q,t=d,f=24,s=1,v=1,i=31", b"AAAA");
        assert_eq!(
            direct.events,
            vec![KittyGraphicsEvent::Reply(
                b"\x1b_Gi=31;OK\x1b\\".to_vec()
            )]
        );

        let file = processor.process(b"a=q,t=f,f=100,i=32", b"L3RtcC9pbWcucG5n");
        assert_eq!(file.events.len(), 1);
        assert!(matches!(file.events[0], KittyGraphicsEvent::Reply(_)));
        assert!(file.terminal_bytes.is_empty());
    }
}
