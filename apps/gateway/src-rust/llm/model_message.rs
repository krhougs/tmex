use std::collections::HashMap;
use std::fmt;

use base64::Engine;
use serde_json::{json, Map, Value};

use crate::agent::{AgentToolDefinition, ToolExecutionKind};

use super::LanguageModelEndpointKind;

#[derive(Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub(crate) struct ModelMessageError {
    message: String,
}

impl ModelMessageError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub(crate) fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Debug for ModelMessageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ModelMessageError")
            .field("message", &self.message)
            .finish()
    }
}

pub(crate) fn chat_messages(
    system_prompt: &str,
    messages: &[Value],
) -> Result<Vec<Value>, ModelMessageError> {
    let mut result = Vec::new();
    if !system_prompt.is_empty() {
        result.push(json!({"role":"system","content":system_prompt}));
    }
    for message in messages {
        let object = object(message, "model message")?;
        let role = string_field(object, "role", "model message")?;
        match role {
            "system" => {
                let content = string_value(object.get("content"), "system message content")?;
                let mut wire = json!({"role":"system","content":content});
                merge_provider_options(&mut wire, object, "openaiCompatible");
                result.push(wire);
            }
            "user" => result.push(chat_user_message(object)?),
            "assistant" => result.push(chat_assistant_message(object)?),
            "tool" => result.extend(chat_tool_messages(object)?),
            _ => return Err(ModelMessageError::new("unsupported model-message role")),
        }
    }
    Ok(result)
}

pub(crate) fn responses_input(
    system_prompt: &str,
    model_id: &str,
    messages: &[Value],
) -> Result<Vec<Value>, ModelMessageError> {
    let mut result = Vec::new();
    if !system_prompt.is_empty() {
        result.push(json!({
            "role": if is_reasoning_model(model_id) { "developer" } else { "system" },
            "content": system_prompt,
        }));
    }
    let mut processed_approval_ids = std::collections::HashSet::new();
    for message in messages {
        let object = object(message, "model message")?;
        let role = string_field(object, "role", "model message")?;
        match role {
            "system" => result.push(json!({
                "role": if is_reasoning_model(model_id) { "developer" } else { "system" },
                "content": string_value(object.get("content"), "system message content")?,
            })),
            "user" => result.push(responses_user_message(object)?),
            "assistant" => append_responses_assistant(&mut result, object)?,
            "tool" => append_responses_tool(&mut result, object, &mut processed_approval_ids)?,
            _ => return Err(ModelMessageError::new("unsupported model-message role")),
        }
    }
    Ok(result)
}

pub(crate) fn wire_tools(
    kind: LanguageModelEndpointKind,
    definitions: &[AgentToolDefinition],
) -> Result<Vec<Value>, ModelMessageError> {
    definitions
        .iter()
        .map(|definition| match (kind, definition.execution) {
            (LanguageModelEndpointKind::ChatCompletions, ToolExecutionKind::Local) => Ok(json!({
                "type":"function",
                "function":{
                    "name":definition.name,
                    "description":definition.description,
                    "parameters":definition.input_schema,
                }
            })),
            (LanguageModelEndpointKind::ChatCompletions, ToolExecutionKind::ProviderHosted) => {
                Err(ModelMessageError::new(
                    "provider-hosted tools require the OpenAI Responses protocol",
                ))
            }
            (LanguageModelEndpointKind::Responses, ToolExecutionKind::Local) => Ok(json!({
                "type":"function",
                "name":definition.name,
                "description":definition.description,
                "parameters":definition.input_schema,
            })),
            (LanguageModelEndpointKind::Responses, ToolExecutionKind::ProviderHosted) => {
                match definition.name.as_str() {
                    "web_search" => Ok(json!({"type":"web_search"})),
                    "image_generation" => Ok(json!({"type":"image_generation"})),
                    "code_interpreter" => Ok(json!({
                        "type":"code_interpreter",
                        "container":{"type":"auto"},
                    })),
                    _ => Err(ModelMessageError::new("unsupported provider-hosted tool")),
                }
            }
        })
        .collect()
}

fn chat_user_message(message: &Map<String, Value>) -> Result<Value, ModelMessageError> {
    let Some(content) = message.get("content") else {
        return Err(ModelMessageError::new("user message has no content"));
    };
    let content = match content {
        Value::String(value) => Value::String(value.clone()),
        Value::Array(parts) => {
            Value::Array(parts.iter().map(chat_user_part).collect::<Result<_, _>>()?)
        }
        _ => return Err(ModelMessageError::new("invalid user message content")),
    };
    let mut wire = json!({"role":"user","content":content});
    merge_provider_options(&mut wire, message, "openaiCompatible");
    Ok(wire)
}

fn chat_user_part(part: &Value) -> Result<Value, ModelMessageError> {
    let object = object(part, "user content part")?;
    match string_field(object, "type", "user content part")? {
        "text" => {
            let mut wire = json!({
                "type":"text",
                "text":string_field(object, "text", "text part")?,
            });
            merge_provider_options(&mut wire, object, "openaiCompatible");
            Ok(wire)
        }
        "image" => {
            let image = string_field(object, "image", "image part")?;
            let media_type = object
                .get("mediaType")
                .and_then(Value::as_str)
                .unwrap_or("image/jpeg");
            let url = data_or_url(image, media_type);
            let mut wire = json!({"type":"image_url","image_url":{"url":url}});
            merge_provider_options(&mut wire, object, "openaiCompatible");
            Ok(wire)
        }
        "file" => chat_file_part(object),
        _ => Err(ModelMessageError::new("unsupported user content part")),
    }
}

fn chat_file_part(object: &Map<String, Value>) -> Result<Value, ModelMessageError> {
    let data = string_field(object, "data", "file part")?;
    let media_type = string_field(object, "mediaType", "file part")?;
    if media_type.starts_with("image/") {
        let mut wire = json!({
            "type":"image_url",
            "image_url":{"url":data_or_url(data, media_type)},
        });
        merge_provider_options(&mut wire, object, "openaiCompatible");
        return Ok(wire);
    }
    if media_type == "application/pdf" {
        if is_url(data) {
            return Err(ModelMessageError::new(
                "OpenAI-compatible Chat does not support PDF URL parts",
            ));
        }
        let mut wire = json!({
            "type":"file",
            "file":{
                "filename":object.get("filename").and_then(Value::as_str).unwrap_or("document.pdf"),
                "file_data":format!("data:application/pdf;base64,{data}"),
            },
        });
        merge_provider_options(&mut wire, object, "openaiCompatible");
        return Ok(wire);
    }
    if matches!(media_type, "audio/wav" | "audio/mp3" | "audio/mpeg") {
        if is_url(data) {
            return Err(ModelMessageError::new(
                "OpenAI-compatible Chat does not support audio URL parts",
            ));
        }
        let mut wire = json!({
            "type":"input_audio",
            "input_audio":{
                "data":data,
                "format":if media_type == "audio/wav" { "wav" } else { "mp3" },
            },
        });
        merge_provider_options(&mut wire, object, "openaiCompatible");
        return Ok(wire);
    }
    if media_type.starts_with("text/") {
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|_| ModelMessageError::new("invalid base64 text file part"))?;
        let text = String::from_utf8_lossy(&decoded);
        let mut wire = json!({"type":"text","text":text});
        merge_provider_options(&mut wire, object, "openaiCompatible");
        return Ok(wire);
    }
    Err(ModelMessageError::new(
        "unsupported OpenAI-compatible Chat file part",
    ))
}

fn chat_assistant_message(message: &Map<String, Value>) -> Result<Value, ModelMessageError> {
    let Some(content) = message.get("content") else {
        return Err(ModelMessageError::new("assistant message has no content"));
    };
    if let Value::String(content) = content {
        let mut wire = json!({"role":"assistant","content":content});
        merge_provider_options(&mut wire, message, "openaiCompatible");
        return Ok(wire);
    }
    let parts = content
        .as_array()
        .ok_or_else(|| ModelMessageError::new("invalid assistant message content"))?;
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut tool_calls = Vec::new();
    for part in parts {
        let object = object(part, "assistant content part")?;
        match string_field(object, "type", "assistant content part")? {
            "text" => text.push_str(string_field(object, "text", "text part")?),
            "reasoning" => reasoning.push_str(string_field(object, "text", "reasoning part")?),
            "tool-call" => {
                if object
                    .get("providerExecuted")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    continue;
                }
                let mut call = json!({
                    "id":string_field(object, "toolCallId", "tool call")?,
                    "type":"function",
                    "function":{
                        "name":string_field(object, "toolName", "tool call")?,
                        "arguments":serde_json::to_string(object.get("input").unwrap_or(&Value::Object(Map::new())))
                            .map_err(|_| ModelMessageError::new("invalid tool input"))?,
                    },
                });
                merge_provider_options(&mut call, object, "openaiCompatible");
                if let Some(signature) = object
                    .get("providerOptions")
                    .and_then(|value| value.get("google"))
                    .and_then(|value| value.get("thoughtSignature"))
                {
                    call["extra_content"] = json!({"google":{"thought_signature":signature}});
                }
                tool_calls.push(call);
            }
            "tool-approval-request" | "tool-result" | "file" => {}
            _ => return Err(ModelMessageError::new("unsupported assistant content part")),
        }
    }
    let mut wire = json!({
        "role":"assistant",
        "content":if tool_calls.is_empty() || !text.is_empty() { Value::String(text) } else { Value::Null },
    });
    if !reasoning.is_empty() {
        wire["reasoning_content"] = Value::String(reasoning);
    }
    if !tool_calls.is_empty() {
        wire["tool_calls"] = Value::Array(tool_calls);
    }
    merge_provider_options(&mut wire, message, "openaiCompatible");
    Ok(wire)
}

fn chat_tool_messages(message: &Map<String, Value>) -> Result<Vec<Value>, ModelMessageError> {
    let parts = array_field(message, "content", "tool message")?;
    parts
        .iter()
        .filter_map(|part| {
            let object = match object(part, "tool content part") {
                Ok(object) => object,
                Err(error) => return Some(Err(error)),
            };
            let kind = match string_field(object, "type", "tool content part") {
                Ok(kind) => kind,
                Err(error) => return Some(Err(error)),
            };
            if kind == "tool-approval-response" {
                return None;
            }
            if kind != "tool-result" {
                return Some(Err(ModelMessageError::new("unsupported tool content part")));
            }
            let mut wire = json!({
                "role":"tool",
                "tool_call_id":match string_field(object, "toolCallId", "tool result") {
                    Ok(value) => value,
                    Err(error) => return Some(Err(error)),
                },
                "content":match tool_output_to_wire(object.get("output")) {
                    Ok(value) => value,
                    Err(error) => return Some(Err(error)),
                },
            });
            merge_provider_options(&mut wire, object, "openaiCompatible");
            Some(Ok(wire))
        })
        .collect()
}

fn responses_user_message(message: &Map<String, Value>) -> Result<Value, ModelMessageError> {
    let content = match message.get("content") {
        Some(Value::String(value)) => vec![json!({"type":"input_text","text":value})],
        Some(Value::Array(parts)) => parts
            .iter()
            .enumerate()
            .map(|(index, part)| responses_user_part(part, index))
            .collect::<Result<_, _>>()?,
        _ => return Err(ModelMessageError::new("invalid user message content")),
    };
    Ok(json!({"role":"user","content":content}))
}

fn responses_user_part(part: &Value, index: usize) -> Result<Value, ModelMessageError> {
    let object = object(part, "user content part")?;
    match string_field(object, "type", "user content part")? {
        "text" => Ok(json!({
            "type":"input_text",
            "text":string_field(object, "text", "text part")?,
        })),
        "image" => {
            let data = string_field(object, "image", "image part")?;
            let media_type = object
                .get("mediaType")
                .and_then(Value::as_str)
                .unwrap_or("image/jpeg");
            let mut result = if data.starts_with("file-") {
                json!({"type":"input_image","file_id":data})
            } else {
                json!({
                    "type":"input_image",
                    "image_url":data_or_url(data, media_type),
                })
            };
            if let Some(detail) = openai_option(object, "imageDetail") {
                result["detail"] = detail.clone();
            }
            Ok(result)
        }
        "file" => {
            let data = string_field(object, "data", "file part")?;
            if is_url(data) {
                Ok(json!({"type":"input_file","file_url":data}))
            } else if data.starts_with("file-") {
                Ok(json!({"type":"input_file","file_id":data}))
            } else {
                let media_type = string_field(object, "mediaType", "file part")?;
                if media_type != "application/pdf" {
                    return Err(ModelMessageError::new(
                        "OpenAI Responses only supports base64 PDF file parts",
                    ));
                }
                Ok(json!({
                    "type":"input_file",
                    "filename":object.get("filename").and_then(Value::as_str).map(str::to_owned)
                        .unwrap_or_else(|| if media_type == "application/pdf" { format!("part-{index}.pdf") } else { format!("part-{index}") }),
                    "file_data":format!("data:{media_type};base64,{data}"),
                }))
            }
        }
        _ => Err(ModelMessageError::new("unsupported user content part")),
    }
}

fn append_responses_assistant(
    output: &mut Vec<Value>,
    message: &Map<String, Value>,
) -> Result<(), ModelMessageError> {
    let content = message
        .get("content")
        .ok_or_else(|| ModelMessageError::new("assistant message has no content"))?;
    if let Value::String(content) = content {
        output.push(json!({
            "role":"assistant",
            "content":[{"type":"output_text","text":content}],
        }));
        return Ok(());
    }
    let parts = content
        .as_array()
        .ok_or_else(|| ModelMessageError::new("invalid assistant message content"))?;
    let mut reasoning_indexes: HashMap<String, usize> = HashMap::new();
    for part in parts {
        let object = object(part, "assistant content part")?;
        match string_field(object, "type", "assistant content part")? {
            "text" => {
                let mut item = json!({
                    "role":"assistant",
                    "content":[{"type":"output_text","text":string_field(object, "text", "text part")?}],
                });
                if let Some(id) = openai_option(object, "itemId") {
                    item["id"] = id.clone();
                }
                if let Some(phase) = openai_option(object, "phase") {
                    if !phase.is_null() {
                        item["phase"] = phase.clone();
                    }
                }
                output.push(item);
            }
            "reasoning" => {
                let encrypted =
                    openai_option(object, "reasoningEncryptedContent").and_then(Value::as_str);
                let Some(encrypted) = encrypted else {
                    continue;
                };
                let id = openai_option(object, "itemId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let summary = string_field(object, "text", "reasoning part")?;
                if let Some(index) = id
                    .as_ref()
                    .and_then(|id| reasoning_indexes.get(id))
                    .copied()
                {
                    if !summary.is_empty() {
                        if let Some(summaries) = output[index]["summary"].as_array_mut() {
                            summaries.push(json!({"type":"summary_text","text":summary}));
                        }
                    }
                    output[index]["encrypted_content"] = Value::String(encrypted.to_owned());
                } else {
                    let mut item = json!({
                        "type":"reasoning",
                        "encrypted_content":encrypted,
                        "summary":if summary.is_empty() { Vec::<Value>::new() } else { vec![json!({"type":"summary_text","text":summary})] },
                    });
                    if let Some(id) = id {
                        item["id"] = Value::String(id.clone());
                        reasoning_indexes.insert(id, output.len());
                    }
                    output.push(item);
                }
            }
            "tool-call" => {
                if object
                    .get("providerExecuted")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    continue;
                }
                let mut item = json!({
                    "type":"function_call",
                    "call_id":string_field(object, "toolCallId", "tool call")?,
                    "name":string_field(object, "toolName", "tool call")?,
                    "arguments":serde_json::to_string(object.get("input").unwrap_or(&Value::Object(Map::new())))
                        .map_err(|_| ModelMessageError::new("invalid tool input"))?,
                });
                if let Some(id) = openai_option(object, "itemId") {
                    item["id"] = id.clone();
                }
                if let Some(namespace) = openai_option(object, "namespace") {
                    item["namespace"] = namespace.clone();
                }
                output.push(item);
            }
            // Provider-executed results cannot be replayed when store is false.
            "tool-result" | "tool-approval-request" | "file" => {}
            _ => return Err(ModelMessageError::new("unsupported assistant content part")),
        }
    }
    Ok(())
}

fn append_responses_tool(
    output: &mut Vec<Value>,
    message: &Map<String, Value>,
    processed_approval_ids: &mut std::collections::HashSet<String>,
) -> Result<(), ModelMessageError> {
    for part in array_field(message, "content", "tool message")? {
        let object = object(part, "tool content part")?;
        match string_field(object, "type", "tool content part")? {
            "tool-result" => output.push(json!({
                "type":"function_call_output",
                "call_id":string_field(object, "toolCallId", "tool result")?,
                "output":tool_output_to_responses(object.get("output"))?,
            })),
            "tool-approval-response"
                if object
                    .get("providerExecuted")
                    .and_then(Value::as_bool)
                    .unwrap_or(false) =>
            {
                let id = string_field(object, "approvalId", "tool approval response")?;
                if processed_approval_ids.insert(id.to_owned()) {
                    output.push(json!({
                        "type":"mcp_approval_response",
                        "approval_request_id":id,
                        "approve":object.get("approved").and_then(Value::as_bool).unwrap_or(false),
                    }));
                }
            }
            "tool-approval-response" => {}
            _ => return Err(ModelMessageError::new("unsupported tool content part")),
        }
    }
    Ok(())
}

fn tool_output_to_wire(output: Option<&Value>) -> Result<String, ModelMessageError> {
    let object = output
        .and_then(Value::as_object)
        .ok_or_else(|| ModelMessageError::new("invalid tool output"))?;
    match string_field(object, "type", "tool output")? {
        "text" | "error-text" => string_field(object, "value", "tool output").map(str::to_owned),
        "execution-denied" => Ok(object
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("Tool execution denied.")
            .to_owned()),
        "json" | "error-json" | "content" => {
            serde_json::to_string(object.get("value").unwrap_or(&Value::Null))
                .map_err(|_| ModelMessageError::new("invalid tool output"))
        }
        _ => Err(ModelMessageError::new("unsupported tool output")),
    }
}

fn tool_output_to_responses(output: Option<&Value>) -> Result<Value, ModelMessageError> {
    let object = output
        .and_then(Value::as_object)
        .ok_or_else(|| ModelMessageError::new("invalid tool output"))?;
    match string_field(object, "type", "tool output")? {
        "text" | "error-text" => Ok(Value::String(
            string_field(object, "value", "tool output")?.to_owned(),
        )),
        "execution-denied" => Ok(Value::String(
            object
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("Tool execution denied.")
                .to_owned(),
        )),
        "json" | "error-json" => serde_json::to_string(object.get("value").unwrap_or(&Value::Null))
            .map(Value::String)
            .map_err(|_| ModelMessageError::new("invalid tool output")),
        "content" => Ok(object
            .get("value")
            .cloned()
            .unwrap_or(Value::Array(Vec::new()))),
        _ => Err(ModelMessageError::new("unsupported tool output")),
    }
}

fn merge_provider_options(target: &mut Value, source: &Map<String, Value>, provider: &str) {
    let Some(options) = source
        .get("providerOptions")
        .and_then(|value| value.get(provider))
        .and_then(Value::as_object)
    else {
        return;
    };
    let Some(target) = target.as_object_mut() else {
        return;
    };
    for (key, value) in options {
        target.insert(key.clone(), value.clone());
    }
}

fn openai_option<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    object
        .get("providerOptions")
        .and_then(|value| value.get("openai"))
        .and_then(|value| value.get(key))
}

fn object<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>, ModelMessageError> {
    value
        .as_object()
        .ok_or_else(|| ModelMessageError::new(format!("invalid {label}")))
}

fn string_field<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    label: &str,
) -> Result<&'a str, ModelMessageError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| ModelMessageError::new(format!("invalid {label}")))
}

fn array_field<'a>(
    object: &'a Map<String, Value>,
    field: &str,
    label: &str,
) -> Result<&'a [Value], ModelMessageError> {
    object
        .get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| ModelMessageError::new(format!("invalid {label}")))
}

fn string_value<'a>(value: Option<&'a Value>, label: &str) -> Result<&'a str, ModelMessageError> {
    value
        .and_then(Value::as_str)
        .ok_or_else(|| ModelMessageError::new(format!("invalid {label}")))
}

fn is_url(value: &str) -> bool {
    value.starts_with("http://") || value.starts_with("https://") || value.starts_with("data:")
}

fn data_or_url(value: &str, media_type: &str) -> String {
    if is_url(value) {
        value.to_owned()
    } else {
        format!("data:{media_type};base64,{value}")
    }
}

fn is_reasoning_model(model_id: &str) -> bool {
    model_id.starts_with("o1")
        || model_id.starts_with("o3")
        || model_id.starts_with("o4-mini")
        || (model_id.starts_with("gpt-5") && !model_id.starts_with("gpt-5-chat"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responses_replays_encrypted_reasoning_and_item_ids_with_store_false() {
        let input = responses_input(
            "system",
            "gpt-5.4",
            &[json!({
                "role":"assistant",
                "content":[
                    {"type":"reasoning","text":"summary","providerOptions":{"openai":{"itemId":"rs_1","reasoningEncryptedContent":"cipher"}}},
                    {"type":"text","text":"answer","providerOptions":{"openai":{"itemId":"msg_1","phase":"final_answer"}}},
                    {"type":"tool-call","toolCallId":"call_1","toolName":"read_screen","input":{},"providerOptions":{"openai":{"itemId":"fc_1"}}}
                ]
            })],
        )
        .unwrap();
        assert_eq!(input[0]["role"], "developer");
        assert_eq!(input[1]["encrypted_content"], "cipher");
        assert_eq!(input[1]["id"], "rs_1");
        assert_eq!(input[2]["id"], "msg_1");
        assert_eq!(input[3]["id"], "fc_1");
    }

    #[test]
    fn chat_skips_approval_responses_and_preserves_tagged_tool_outputs() {
        let messages = chat_messages(
            "",
            &[json!({
                "role":"tool",
                "content":[
                    {"type":"tool-approval-response","approvalId":"a","approved":true},
                    {"type":"tool-result","toolCallId":"c","toolName":"read_screen","output":{"type":"json","value":{"ok":true}}}
                ]
            })],
        )
        .unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["tool_call_id"], "c");
        assert_eq!(messages[0]["content"], "{\"ok\":true}");
    }
}
