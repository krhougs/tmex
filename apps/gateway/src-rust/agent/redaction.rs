use serde_json::{Map, Value};

use super::redact_secrets;

pub fn redact_json_strings(value: &Value) -> Value {
    match value {
        Value::String(value) => Value::String(redact_secrets(value).text),
        Value::Array(values) => Value::Array(values.iter().map(redact_json_strings).collect()),
        Value::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), redact_json_strings(value)))
                .collect(),
        ),
        value => value.clone(),
    }
}

fn redact_tool_output(output: &Value) -> Value {
    let Some(object) = output.as_object() else {
        return output.clone();
    };
    match object.get("type").and_then(Value::as_str) {
        Some("text") => {
            let Some(value) = object.get("value").and_then(Value::as_str) else {
                return output.clone();
            };
            let mut redacted = object.clone();
            redacted.insert(
                "value".to_owned(),
                Value::String(redact_secrets(value).text),
            );
            Value::Object(redacted)
        }
        Some("json") => {
            let mut redacted = object.clone();
            if let Some(value) = object.get("value") {
                redacted.insert("value".to_owned(), redact_json_strings(value));
            }
            Value::Object(redacted)
        }
        _ => output.clone(),
    }
}

pub fn redact_outbound_message(message: &Value) -> Value {
    let Some(object) = message.as_object() else {
        return message.clone();
    };
    if !matches!(
        object.get("role").and_then(Value::as_str),
        Some("tool" | "assistant")
    ) {
        return message.clone();
    }
    let Some(content) = object.get("content").and_then(Value::as_array) else {
        return message.clone();
    };

    let redacted_content = content
        .iter()
        .map(|part| {
            let Some(part_object) = part.as_object() else {
                return part.clone();
            };
            if part_object.get("type").and_then(Value::as_str) != Some("tool-result") {
                return part.clone();
            }
            let mut redacted = part_object.clone();
            if let Some(output) = part_object.get("output") {
                redacted.insert("output".to_owned(), redact_tool_output(output));
            }
            Value::Object(redacted)
        })
        .collect();
    let mut redacted: Map<String, Value> = object.clone();
    redacted.insert("content".to_owned(), Value::Array(redacted_content));
    Value::Object(redacted)
}

pub fn redact_outbound_messages(messages: &[Value]) -> Vec<Value> {
    messages.iter().map(redact_outbound_message).collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn redacts_only_machine_tool_results_and_keeps_user_and_assistant_text() {
        let secret = "sk-abcdefghijklmnop";
        let messages = vec![
            json!({"role":"user","content":secret}),
            json!({"role":"assistant","content":[
                {"type":"text","text":secret},
                {"type":"tool-result","output":{"type":"json","value":{"nested":secret}}}
            ]}),
            json!({"role":"tool","content":[
                {"type":"tool-result","output":{"type":"text","value":secret}}
            ]}),
        ];
        let redacted = redact_outbound_messages(&messages);
        assert_eq!(redacted[0]["content"], secret);
        assert_eq!(redacted[1]["content"][0]["text"], secret);
        assert_eq!(
            redacted[1]["content"][1]["output"]["value"]["nested"],
            "[REDACTED:token]"
        );
        assert_eq!(
            redacted[2]["content"][0]["output"]["value"],
            "[REDACTED:token]"
        );
    }
}
