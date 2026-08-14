mod evaluator;
mod production_runtime;
mod prompt;
mod runtime;
mod service;

pub use evaluator::{
    compile_watch_pattern, evaluate_watch_rule, find_last_match, CompiledWatchPattern,
    WatchEvalOutput, WatchEvalStateUpdates, WatchMatch,
};
pub use production_runtime::{
    GatewayWatchRuntime, GatewayWatchRuntimeDependencies, TmuxWatchDevice, WatchDeviceCloseSink,
    WatchMessageFormatter, WatchModelGenerator, WatchNotificationSink,
};
pub use prompt::{
    build_confirm_prompt, build_judge_prompt, build_summary_prompt, effective_interval_seconds,
    SCREEN_PROMPT_CHAR_LIMIT,
};
pub use runtime::{
    WatchDevice, WatchDeviceListener, WatchFuture, WatchIntervalCallback, WatchLlmOperation,
    WatchLlmRequest, WatchLlmResponse, WatchMessage, WatchRuntime, WatchRuntimeError,
    WatchSchedule, WatchSubscription, WatchTmuxEntityKind,
};
pub use service::{WatchRuleSample, WatchService, WatchServiceConfig, WatchServiceError};
