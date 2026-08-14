use std::collections::BTreeMap;

use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, SecondsFormat, TimeZone, Utc};
use sea_orm::{DbBackend, ProxyRow, Statement, Value as SeaValue};
use turso::{Row as TursoRow, Value as TursoValue};
use uuid::Uuid;

use crate::DbError;

#[derive(Clone, Debug)]
pub(crate) struct ColumnMetadata {
    pub(crate) name: String,
    pub(crate) declared_type: Option<String>,
}

pub(crate) fn statement_parts(statement: Statement) -> Result<(String, Vec<TursoValue>), DbError> {
    if statement.db_backend != DbBackend::Sqlite {
        return Err(DbError::UnsupportedBackend);
    }

    let values = statement
        .values
        .map(|values| {
            values
                .0
                .into_iter()
                .map(sea_value_to_turso)
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();

    Ok((statement.sql, values))
}

pub(crate) fn row_to_proxy(columns: &[ColumnMetadata], row: TursoRow) -> Result<ProxyRow, DbError> {
    let mut values = BTreeMap::new();
    for (index, column) in columns.iter().enumerate() {
        if values.contains_key(&column.name) {
            return Err(DbError::DuplicateColumn(column.name.clone()));
        }
        let value = row
            .get_value(index)
            .map_err(|error| DbError::turso("failed to read query row", error))?;
        values.insert(column.name.clone(), turso_value_to_sea(value, column)?);
    }
    Ok(ProxyRow::new(values))
}

fn sea_value_to_turso(value: SeaValue) -> Result<TursoValue, DbError> {
    let value = match value {
        SeaValue::Bool(value) => option_integer(value.map(i64::from)),
        SeaValue::TinyInt(value) => option_integer(value.map(i64::from)),
        SeaValue::SmallInt(value) => option_integer(value.map(i64::from)),
        SeaValue::Int(value) => option_integer(value.map(i64::from)),
        SeaValue::BigInt(value) => option_integer(value),
        SeaValue::TinyUnsigned(value) => option_integer(value.map(i64::from)),
        SeaValue::SmallUnsigned(value) => option_integer(value.map(i64::from)),
        SeaValue::Unsigned(value) => option_integer(value.map(i64::from)),
        SeaValue::BigUnsigned(value) => match value {
            Some(value) => {
                TursoValue::Integer(i64::try_from(value).map_err(|_| DbError::ValueOutOfRange {
                    target: "SQLite INTEGER",
                    value: value.to_string(),
                })?)
            }
            None => TursoValue::Null,
        },
        SeaValue::Float(value) => option_real(value.map(f64::from)),
        SeaValue::Double(value) => option_real(value),
        SeaValue::String(value) => option_text(value.map(|value| *value)),
        SeaValue::Char(value) => option_text(value.map(|value| value.to_string())),
        SeaValue::Bytes(value) => value.map_or(TursoValue::Null, |value| TursoValue::Blob(*value)),
        SeaValue::Json(value) => match value {
            Some(value) => TursoValue::Text(
                serde_json::to_string(&*value)
                    .map_err(|error| DbError::UnsupportedValue(error.to_string()))?,
            ),
            None => TursoValue::Null,
        },
        SeaValue::ChronoDate(value) => {
            option_text(value.map(|value| value.format("%F").to_string()))
        }
        SeaValue::ChronoTime(value) => {
            option_text(value.map(|value| value.format("%T%.f").to_string()))
        }
        SeaValue::ChronoDateTime(value) => {
            option_text(value.map(|value| value.format("%F %T%.f").to_string()))
        }
        SeaValue::ChronoDateTimeUtc(value) => {
            option_text(value.map(|value| value.to_rfc3339_opts(SecondsFormat::AutoSi, false)))
        }
        SeaValue::ChronoDateTimeLocal(value) => {
            option_text(value.map(|value| value.to_rfc3339_opts(SecondsFormat::AutoSi, false)))
        }
        SeaValue::ChronoDateTimeWithTimeZone(value) => {
            option_text(value.map(|value| value.to_rfc3339_opts(SecondsFormat::AutoSi, false)))
        }
        SeaValue::Uuid(value) => value.map_or(TursoValue::Null, |value| {
            TursoValue::Blob(value.as_bytes().to_vec())
        }),
        #[allow(unreachable_patterns)]
        value => return Err(DbError::UnsupportedValue(format!("{value:?}"))),
    };
    Ok(value)
}

fn option_integer(value: Option<i64>) -> TursoValue {
    value.map_or(TursoValue::Null, TursoValue::Integer)
}

fn option_real(value: Option<f64>) -> TursoValue {
    value.map_or(TursoValue::Null, TursoValue::Real)
}

fn option_text(value: Option<String>) -> TursoValue {
    value.map_or(TursoValue::Null, TursoValue::Text)
}

#[derive(Clone, Copy, Debug)]
enum ColumnKind {
    Bool,
    TinyInt,
    SmallInt,
    Int,
    BigInt,
    TinyUnsigned,
    SmallUnsigned,
    Unsigned,
    BigUnsigned,
    Float,
    Double,
    String,
    Char,
    Bytes,
    Json,
    Date,
    Time,
    DateTime,
    Uuid,
    Unknown,
}

fn column_kind(declared_type: Option<&str>) -> ColumnKind {
    let Some(declared_type) = declared_type else {
        return ColumnKind::Unknown;
    };
    let declared_type = declared_type.trim().to_ascii_uppercase();
    let base = declared_type
        .split(['(', ' '])
        .next()
        .unwrap_or(declared_type.as_str());

    match base {
        "BOOL" | "BOOLEAN" => ColumnKind::Bool,
        "TINYINT" => ColumnKind::TinyInt,
        "SMALLINT" => ColumnKind::SmallInt,
        "INT" | "MEDIUMINT" => ColumnKind::Int,
        "INTEGER" | "BIGINT" | "INT8" => ColumnKind::BigInt,
        "TINYUNSIGNED" => ColumnKind::TinyUnsigned,
        "SMALLUNSIGNED" => ColumnKind::SmallUnsigned,
        "UNSIGNED" => ColumnKind::Unsigned,
        "BIGUNSIGNED" => ColumnKind::BigUnsigned,
        "FLOAT" => ColumnKind::Float,
        "REAL" | "DOUBLE" | "NUMERIC" | "DECIMAL" | "REAL_DECIMAL" | "REAL_MONEY" => {
            ColumnKind::Double
        }
        "CHAR" => ColumnKind::Char,
        "BLOB" | "BINARY" | "VARBINARY" | "VARBINARY_BLOB" => ColumnKind::Bytes,
        "JSON" | "JSONB" | "JSON_TEXT" | "JSONB_TEXT" => ColumnKind::Json,
        "DATE" | "DATE_TEXT" => ColumnKind::Date,
        "TIME" | "TIME_TEXT" => ColumnKind::Time,
        "DATETIME"
        | "TIMESTAMP"
        | "DATETIME_TEXT"
        | "TIMESTAMP_TEXT"
        | "TIMESTAMP_WITH_TIMEZONE_TEXT" => ColumnKind::DateTime,
        "UUID" | "UUID_TEXT" => ColumnKind::Uuid,
        "TEXT" | "VARCHAR" | "NVARCHAR" | "CLOB" | "STRING" | "ENUM_TEXT" => ColumnKind::String,
        _ => ColumnKind::Unknown,
    }
}

fn turso_value_to_sea(value: TursoValue, column: &ColumnMetadata) -> Result<SeaValue, DbError> {
    let kind = column_kind(column.declared_type.as_deref());
    match value {
        TursoValue::Null => Ok(null_for_kind(kind)),
        TursoValue::Integer(value) => integer_to_sea(value, kind, column),
        TursoValue::Real(value) => match kind {
            ColumnKind::Float => Ok(SeaValue::Float(Some(value as f32))),
            _ => Ok(SeaValue::Double(Some(value))),
        },
        TursoValue::Text(value) => text_to_sea(value, kind, column),
        TursoValue::Blob(value) => match kind {
            ColumnKind::Uuid => Uuid::from_slice(&value)
                .map(|value| SeaValue::Uuid(Some(Box::new(value))))
                .map_err(|error| invalid_column(column, error.to_string())),
            _ => Ok(SeaValue::Bytes(Some(Box::new(value)))),
        },
    }
}

fn null_for_kind(kind: ColumnKind) -> SeaValue {
    match kind {
        ColumnKind::Bool => SeaValue::Bool(None),
        ColumnKind::TinyInt => SeaValue::TinyInt(None),
        ColumnKind::SmallInt => SeaValue::SmallInt(None),
        ColumnKind::Int => SeaValue::Int(None),
        ColumnKind::BigInt => SeaValue::BigInt(None),
        ColumnKind::TinyUnsigned => SeaValue::TinyUnsigned(None),
        ColumnKind::SmallUnsigned => SeaValue::SmallUnsigned(None),
        ColumnKind::Unsigned => SeaValue::Unsigned(None),
        ColumnKind::BigUnsigned => SeaValue::BigUnsigned(None),
        ColumnKind::Float => SeaValue::Float(None),
        ColumnKind::Double => SeaValue::Double(None),
        ColumnKind::Char => SeaValue::Char(None),
        ColumnKind::Bytes => SeaValue::Bytes(None),
        ColumnKind::Json => SeaValue::Json(None),
        ColumnKind::Date => SeaValue::ChronoDate(None),
        ColumnKind::Time => SeaValue::ChronoTime(None),
        ColumnKind::DateTime => SeaValue::ChronoDateTimeUtc(None),
        ColumnKind::Uuid => SeaValue::Uuid(None),
        ColumnKind::String | ColumnKind::Unknown => SeaValue::String(None),
    }
}

fn integer_to_sea(
    value: i64,
    kind: ColumnKind,
    column: &ColumnMetadata,
) -> Result<SeaValue, DbError> {
    let out_of_range =
        |target: &'static str| invalid_column(column, format!("{value} does not fit {target}"));
    let value = match kind {
        ColumnKind::Bool => SeaValue::Bool(Some(value != 0)),
        ColumnKind::TinyInt => {
            SeaValue::TinyInt(Some(i8::try_from(value).map_err(|_| out_of_range("i8"))?))
        }
        ColumnKind::SmallInt => {
            SeaValue::SmallInt(Some(i16::try_from(value).map_err(|_| out_of_range("i16"))?))
        }
        ColumnKind::Int => {
            SeaValue::Int(Some(i32::try_from(value).map_err(|_| out_of_range("i32"))?))
        }
        ColumnKind::TinyUnsigned => {
            SeaValue::TinyUnsigned(Some(u8::try_from(value).map_err(|_| out_of_range("u8"))?))
        }
        ColumnKind::SmallUnsigned => {
            SeaValue::SmallUnsigned(Some(u16::try_from(value).map_err(|_| out_of_range("u16"))?))
        }
        ColumnKind::Unsigned => {
            SeaValue::Unsigned(Some(u32::try_from(value).map_err(|_| out_of_range("u32"))?))
        }
        ColumnKind::BigUnsigned => {
            SeaValue::BigUnsigned(Some(u64::try_from(value).map_err(|_| out_of_range("u64"))?))
        }
        ColumnKind::Float => SeaValue::Float(Some(value as f32)),
        ColumnKind::Double => SeaValue::Double(Some(value as f64)),
        ColumnKind::BigInt
        | ColumnKind::Unknown
        | ColumnKind::String
        | ColumnKind::Char
        | ColumnKind::Bytes
        | ColumnKind::Json
        | ColumnKind::Date
        | ColumnKind::Time
        | ColumnKind::DateTime
        | ColumnKind::Uuid => SeaValue::BigInt(Some(value)),
    };
    Ok(value)
}

fn text_to_sea(
    value: String,
    kind: ColumnKind,
    column: &ColumnMetadata,
) -> Result<SeaValue, DbError> {
    match kind {
        ColumnKind::Char => {
            let mut chars = value.chars();
            let first = chars
                .next()
                .ok_or_else(|| invalid_column(column, "empty CHAR value".to_owned()))?;
            if chars.next().is_some() {
                return Err(invalid_column(
                    column,
                    "CHAR value contains more than one character".to_owned(),
                ));
            }
            Ok(SeaValue::Char(Some(first)))
        }
        ColumnKind::Json => serde_json::from_str(&value)
            .map(|value| SeaValue::Json(Some(Box::new(value))))
            .map_err(|error| invalid_column(column, error.to_string())),
        ColumnKind::Date => NaiveDate::parse_from_str(&value, "%F")
            .map(|value| SeaValue::ChronoDate(Some(Box::new(value))))
            .map_err(|error| invalid_column(column, error.to_string())),
        ColumnKind::Time => NaiveTime::parse_from_str(&value, "%T%.f")
            .map(|value| SeaValue::ChronoTime(Some(Box::new(value))))
            .map_err(|error| invalid_column(column, error.to_string())),
        ColumnKind::DateTime => parse_datetime_utc(&value)
            .map(|value| SeaValue::ChronoDateTimeUtc(Some(Box::new(value))))
            .ok_or_else(|| invalid_column(column, format!("invalid datetime `{value}`"))),
        ColumnKind::Uuid => Uuid::parse_str(&value)
            .map(|value| SeaValue::Uuid(Some(Box::new(value))))
            .map_err(|error| invalid_column(column, error.to_string())),
        _ => Ok(SeaValue::String(Some(Box::new(value)))),
    }
}

fn parse_datetime_utc(value: &str) -> Option<DateTime<Utc>> {
    if let Ok(value) = DateTime::parse_from_rfc3339(value) {
        return Some(value.with_timezone(&Utc));
    }

    ["%F %T%.f", "%FT%T%.f", "%F %T", "%FT%T"]
        .into_iter()
        .find_map(|format| NaiveDateTime::parse_from_str(value, format).ok())
        .map(|value| Utc.from_utc_datetime(&value))
}

fn invalid_column(column: &ColumnMetadata, message: String) -> DbError {
    DbError::InvalidColumnValue {
        column: column.name.clone(),
        declared_type: column
            .declared_type
            .clone()
            .unwrap_or_else(|| "unknown".to_owned()),
        message,
    }
}
