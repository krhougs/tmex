use std::time::Duration;

use tokio::sync::oneshot;

pub(crate) enum RuntimeControl {
    ScheduleRestart {
        delay: Duration,
        response: oneshot::Sender<()>,
    },
}
