use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};

use serde_json::Value;

const EN_US: &str = include_str!("../../../packages/shared/src/i18n/locales/en_US.json");
const ZH_CN: &str = include_str!("../../../packages/shared/src/i18n/locales/zh_CN.json");
const JA_JP: &str = include_str!("../../../packages/shared/src/i18n/locales/ja_JP.json");

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum GatewayLocale {
    #[default]
    EnUs,
    ZhCn,
    JaJp,
}

impl GatewayLocale {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "en_US" => Some(Self::EnUs),
            "zh_CN" => Some(Self::ZhCn),
            "ja_JP" => Some(Self::JaJp),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::EnUs => "en_US",
            Self::ZhCn => "zh_CN",
            Self::JaJp => "ja_JP",
        }
    }

    const fn index(self) -> usize {
        match self {
            Self::EnUs => 0,
            Self::ZhCn => 1,
            Self::JaJp => 2,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct GatewayI18n {
    locale: Arc<RwLock<GatewayLocale>>,
}

impl GatewayI18n {
    pub fn new(locale: GatewayLocale) -> Self {
        Self {
            locale: Arc::new(RwLock::new(locale)),
        }
    }

    pub fn locale(&self) -> GatewayLocale {
        *self
            .locale
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn set_locale(&self, locale: GatewayLocale) {
        *self
            .locale
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = locale;
    }

    pub fn translate(&self, key: &str) -> String {
        self.translate_with(key, &HashMap::new())
    }

    pub fn translate_with(&self, key: &str, parameters: &HashMap<&str, String>) -> String {
        let resources = resources();
        let template = lookup(&resources[self.locale().index()], key)
            .or_else(|| lookup(&resources[GatewayLocale::EnUs.index()], key))
            .unwrap_or(key);
        interpolate(template, parameters)
    }
}

fn resources() -> &'static [Value; 3] {
    static RESOURCES: OnceLock<[Value; 3]> = OnceLock::new();
    RESOURCES.get_or_init(|| {
        [
            serde_json::from_str(EN_US).unwrap_or(Value::Null),
            serde_json::from_str(ZH_CN).unwrap_or(Value::Null),
            serde_json::from_str(JA_JP).unwrap_or(Value::Null),
        ]
    })
}

fn lookup<'a>(resource: &'a Value, key: &str) -> Option<&'a str> {
    let mut current = resource.get("translation")?;
    for segment in key.split('.') {
        current = current.get(segment)?;
    }
    current.as_str()
}

fn interpolate(template: &str, parameters: &HashMap<&str, String>) -> String {
    let mut output = String::with_capacity(template.len());
    let mut remaining = template;
    while let Some(start) = remaining.find("{{") {
        output.push_str(&remaining[..start]);
        let after_start = &remaining[start + 2..];
        let Some(end) = after_start.find("}}") else {
            output.push_str(&remaining[start..]);
            return output;
        };
        let name = after_start[..end].trim();
        if let Some(value) = parameters.get(name) {
            output.push_str(value);
        } else {
            output.push_str(&remaining[start..start + end + 4]);
        }
        remaining = &after_start[end + 2..];
    }
    output.push_str(remaining);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embeds_all_locales_with_english_fallback_and_interpolation() {
        let i18n = GatewayI18n::new(GatewayLocale::JaJp);
        assert_ne!(i18n.translate("apiError.notFound"), "apiError.notFound");

        i18n.set_locale(GatewayLocale::ZhCn);
        let parameters = HashMap::from([
            ("delay", "5".to_owned()),
            ("attempt", "1".to_owned()),
            ("maxRetries", "3".to_owned()),
        ]);
        let message = i18n.translate_with("sshError.reconnecting", &parameters);
        assert!(message.contains('5') && message.contains('1') && message.contains('3'));

        assert_eq!(
            i18n.translate("missing.gateway.translation"),
            "missing.gateway.translation"
        );
    }
}
