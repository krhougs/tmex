use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};

use super::WebhookEvent;

const URI_COMPONENT_ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

pub fn build_pane_url(event: &WebhookEvent) -> Option<String> {
    let tmux = event.tmux.as_ref()?;
    let window_id = tmux
        .window_id
        .as_deref()
        .filter(|value| !value.is_empty())?;
    let pane_id = tmux.pane_id.as_deref().filter(|value| !value.is_empty())?;
    let base = event.site.url.strip_suffix('/').unwrap_or(&event.site.url);
    Some(format!(
        "{base}/devices/{}/windows/{}/panes/{}",
        encode_uri_component(&event.device.id),
        encode_uri_component(window_id),
        encode_uri_component(pane_id)
    ))
}

pub fn normalize_http_url(input: Option<String>) -> Option<String> {
    let mut url = reqwest::Url::parse(input.as_deref()?).ok()?;
    match url.scheme() {
        "http" | "https" => {
            if url.path().is_empty() {
                url.set_path("/");
            }
            Some(url.to_string())
        }
        _ => None,
    }
}

fn encode_uri_component(value: &str) -> String {
    utf8_percent_encode(value, URI_COMPONENT_ENCODE_SET).to_string()
}
