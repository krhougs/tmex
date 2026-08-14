use std::collections::BTreeMap;
use std::sync::Arc;

use futures_util::future::BoxFuture;

use crate::crypto::{CryptoContext, MasterKey};
use crate::database::repository::Repository;
use crate::entity::devices;

use super::connection_types::{DeviceSessionConfig, LocalTmuxConfig, TmuxTransportConfig};
use super::device_session_runtime::{
    DefaultTmuxTransportFactory, DeviceSessionRuntime, TmuxTransportFactory,
};
use super::runtime_registry::{RuntimeRegistryError, TmuxRuntimeFactory};
use super::spawn_policy::SpawnPolicy;
use super::ssh_auth::{SecretString, SshAuthMode};
use super::ssh_connect_config::SshDeviceConfig;
use super::transport::SystemOpenSshInvocationBuilder;
use super::TmuxLifecycleSink;

#[derive(Clone)]
pub struct RepositoryTmuxRuntimeConfig {
    pub tmux_bin: String,
    pub tmux_socket: String,
    pub tmux_term_program: String,
    pub tmux_window_style: String,
    pub allow_passthrough: bool,
    pub enable_control_mode: bool,
    pub environment: BTreeMap<String, String>,
}

#[derive(Clone)]
pub struct RepositoryTmuxRuntimeFactory {
    repository: Repository,
    master_key: MasterKey,
    spawn_policy: Arc<dyn SpawnPolicy>,
    config: RepositoryTmuxRuntimeConfig,
    transport_factory: Arc<dyn TmuxTransportFactory>,
    lifecycle_sink: Option<Arc<dyn TmuxLifecycleSink>>,
}

impl RepositoryTmuxRuntimeFactory {
    pub fn new(
        repository: Repository,
        master_key: MasterKey,
        spawn_policy: Arc<dyn SpawnPolicy>,
        config: RepositoryTmuxRuntimeConfig,
    ) -> Self {
        let transport_factory = Arc::new(DefaultTmuxTransportFactory::new(
            config.environment.clone(),
            Arc::new(SystemOpenSshInvocationBuilder::default()),
        ));
        Self::with_transport_factory(
            repository,
            master_key,
            spawn_policy,
            config,
            transport_factory,
        )
    }

    pub fn with_transport_factory(
        repository: Repository,
        master_key: MasterKey,
        spawn_policy: Arc<dyn SpawnPolicy>,
        config: RepositoryTmuxRuntimeConfig,
        transport_factory: Arc<dyn TmuxTransportFactory>,
    ) -> Self {
        Self {
            repository,
            master_key,
            spawn_policy,
            config,
            transport_factory,
            lifecycle_sink: None,
        }
    }

    pub fn with_lifecycle_sink(mut self, lifecycle_sink: Arc<dyn TmuxLifecycleSink>) -> Self {
        self.lifecycle_sink = Some(lifecycle_sink);
        self
    }

    async fn load_session_config(
        &self,
        device_id: &str,
    ) -> Result<DeviceSessionConfig, RuntimeRegistryError> {
        let device = self
            .repository
            .get_device_by_id(device_id)
            .await
            .map_err(|error| {
                RuntimeRegistryError::new(format!(
                    "tmux_device_load_failed: failed to load device `{device_id}`: {error}"
                ))
            })?
            .ok_or_else(|| {
                RuntimeRegistryError::new(format!(
                    "tmux_device_not_found: device `{device_id}` was not found"
                ))
            })?;

        let transport = match device.r#type.as_str() {
            "local" => TmuxTransportConfig::Local(LocalTmuxConfig {
                tmux_bin: self.config.tmux_bin.clone(),
                socket_name: normalized(Some(&self.config.tmux_socket)),
                environment: self.config.environment.clone(),
            }),
            "ssh" => TmuxTransportConfig::Ssh(self.ssh_device_config(&device)?),
            device_type => {
                return Err(RuntimeRegistryError::new(format!(
                    "tmux_device_type_invalid: device `{}` has unsupported type `{device_type}`",
                    device.id
                )));
            }
        };

        Ok(DeviceSessionConfig {
            device_id: device.id.clone(),
            device_name: normalized(Some(&device.name)),
            session_name: normalized(device.session.as_deref())
                .unwrap_or_else(|| "tmex".to_owned()),
            default_working_dir: normalized(device.default_working_dir.as_deref()),
            tmux_term_program: self.config.tmux_term_program.clone(),
            tmux_window_style: self.config.tmux_window_style.clone(),
            allow_passthrough: self.config.allow_passthrough,
            enable_control_mode: self.config.enable_control_mode,
            transport,
            spawn_policy: self.spawn_policy.clone(),
        })
    }

    fn ssh_device_config(
        &self,
        device: &devices::Model,
    ) -> Result<SshDeviceConfig, RuntimeRegistryError> {
        let auth_mode = parse_auth_mode(device)?;
        let port = device
            .port
            .map(|port| {
                u16::try_from(port).map_err(|_| {
                    RuntimeRegistryError::new(format!(
                        "tmux_ssh_port_invalid: device `{}` has port `{port}` outside the u16 range",
                        device.id
                    ))
                })
            })
            .transpose()?;

        let (password, private_key, private_key_passphrase) = match auth_mode {
            SshAuthMode::Password => {
                let ciphertext = device
                    .password_enc
                    .as_deref()
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        RuntimeRegistryError::new("auth_password_missing: 密码认证未提供密码")
                    })?;
                (
                    Some(self.decrypt_secret(device, "password_enc", ciphertext)?),
                    None,
                    None,
                )
            }
            SshAuthMode::Key => {
                let ciphertext = device
                    .private_key_enc
                    .as_deref()
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        RuntimeRegistryError::new("auth_key_missing: 私钥认证未提供私钥")
                    })?;
                let passphrase = device
                    .private_key_passphrase_enc
                    .as_deref()
                    .filter(|value| !value.is_empty())
                    .map(|ciphertext| {
                        self.decrypt_secret(device, "private_key_passphrase_enc", ciphertext)
                    })
                    .transpose()?;
                (
                    None,
                    Some(self.decrypt_secret(device, "private_key_enc", ciphertext)?),
                    passphrase,
                )
            }
            SshAuthMode::Agent | SshAuthMode::ConfigRef => (None, None, None),
            SshAuthMode::Auto => {
                if let Some(ciphertext) = device
                    .private_key_enc
                    .as_deref()
                    .filter(|value| !value.is_empty())
                {
                    (
                        None,
                        Some(self.decrypt_secret(device, "private_key_enc", ciphertext)?),
                        None,
                    )
                } else if let Some(ciphertext) = device
                    .password_enc
                    .as_deref()
                    .filter(|value| !value.is_empty())
                {
                    (
                        Some(self.decrypt_secret(device, "password_enc", ciphertext)?),
                        None,
                        None,
                    )
                } else {
                    (None, None, None)
                }
            }
        };

        Ok(SshDeviceConfig {
            device_id: device.id.clone(),
            host: device.host.clone(),
            port,
            username: device.username.clone(),
            config_ref: device.ssh_config_ref.clone(),
            auth_mode,
            password,
            private_key,
            private_key_passphrase,
        })
    }

    fn decrypt_secret(
        &self,
        device: &devices::Model,
        field: &'static str,
        ciphertext: &str,
    ) -> Result<SecretString, RuntimeRegistryError> {
        self.master_key
            .decrypt_with_context(
                ciphertext,
                CryptoContext::new("device")
                    .entity_id(device.id.clone())
                    .field(field),
            )
            .map(SecretString::new)
            .map_err(|error| RuntimeRegistryError::new(error.to_string()))
    }
}

impl TmuxRuntimeFactory<DeviceSessionRuntime> for RepositoryTmuxRuntimeFactory {
    fn create(
        &self,
        device_id: String,
    ) -> BoxFuture<'static, Result<Arc<DeviceSessionRuntime>, RuntimeRegistryError>> {
        let factory = self.clone();
        Box::pin(async move {
            let config = factory.load_session_config(&device_id).await?;
            DeviceSessionRuntime::start_with_lifecycle_sink(
                config,
                factory.transport_factory.clone(),
                factory.lifecycle_sink.clone(),
            )
            .await
            .map(Arc::new)
            .map_err(|error| {
                RuntimeRegistryError::new(format!(
                    "tmux_runtime_start_failed: failed to start device `{device_id}`: {error}"
                ))
            })
        })
    }
}

fn parse_auth_mode(device: &devices::Model) -> Result<SshAuthMode, RuntimeRegistryError> {
    match device.auth_mode.as_str() {
        "password" => Ok(SshAuthMode::Password),
        "key" => Ok(SshAuthMode::Key),
        "agent" => Ok(SshAuthMode::Agent),
        "configRef" => Ok(SshAuthMode::ConfigRef),
        "auto" => Ok(SshAuthMode::Auto),
        auth_mode => Err(RuntimeRegistryError::new(format!(
            "tmux_ssh_auth_mode_invalid: device `{}` has unsupported auth mode `{auth_mode}`",
            device.id
        ))),
    }
}

fn normalized(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use tmex_db::DbConfig;

    use crate::database::DatabaseBootstrap;

    use super::*;
    use crate::tmux::{DeviceSessionRuntimeError, SpawnIsolation};

    #[derive(Default)]
    struct CapturingTransportFactory {
        configs: Mutex<Vec<DeviceSessionConfig>>,
    }

    #[async_trait]
    impl TmuxTransportFactory for CapturingTransportFactory {
        async fn create(
            &self,
            config: &DeviceSessionConfig,
        ) -> Result<Arc<dyn super::super::TmuxTransport>, DeviceSessionRuntimeError> {
            self.configs.lock().unwrap().push(config.clone());
            Err(DeviceSessionRuntimeError::Closed)
        }
    }

    #[derive(Default)]
    struct TestSpawnPolicy;

    impl SpawnPolicy for TestSpawnPolicy {
        fn isolation(&self) -> SpawnIsolation {
            SpawnIsolation::HostManaged
        }

        fn configure(
            &self,
            _request: &super::super::SpawnRequest,
            _command: &mut tokio::process::Command,
        ) -> std::io::Result<()> {
            Ok(())
        }
    }

    async fn test_repository() -> Repository {
        let database = DatabaseBootstrap::new(DbConfig::in_memory())
            .run()
            .await
            .expect("bootstrap repository");
        Repository::new(database)
    }

    fn device(id: &str, kind: &str, auth_mode: &str) -> devices::Model {
        devices::Model {
            id: id.to_owned(),
            name: "  Workstation  ".to_owned(),
            r#type: kind.to_owned(),
            host: Some(" example.test ".to_owned()),
            port: Some(22),
            username: Some(" alice ".to_owned()),
            ssh_config_ref: None,
            session: Some("  session-one  ".to_owned()),
            auth_mode: auth_mode.to_owned(),
            password_enc: None,
            private_key_enc: None,
            private_key_passphrase_enc: None,
            default_working_dir: Some("  /workspace  ".to_owned()),
            sort_order: 0,
            created_at: "2026-08-12T00:00:00.000Z".to_owned(),
            updated_at: "2026-08-12T00:00:00.000Z".to_owned(),
        }
    }

    fn factory_config() -> RepositoryTmuxRuntimeConfig {
        RepositoryTmuxRuntimeConfig {
            tmux_bin: "custom-tmux".to_owned(),
            tmux_socket: "   ".to_owned(),
            tmux_term_program: "ghostty".to_owned(),
            tmux_window_style: "fg=#fff,bg=#000".to_owned(),
            allow_passthrough: true,
            enable_control_mode: false,
            environment: BTreeMap::from([("HOME".to_owned(), "/home/test".to_owned())]),
        }
    }

    #[tokio::test]
    async fn maps_local_and_ssh_devices_without_leaking_or_over_decrypting_secrets() {
        let repository = test_repository().await;
        let key = MasterKey::development_default();
        let mut local = device("local-device", "local", "auto");
        local.name = "   ".to_owned();
        local.session = Some("   ".to_owned());
        local.default_working_dir = Some("   ".to_owned());
        local.password_enc = Some("unused-invalid-ciphertext".to_owned());
        repository.create_device(local).await.unwrap();

        let private_key_plaintext = "private-key-plaintext-marker";
        let private_key_ciphertext = key.encrypt(private_key_plaintext).unwrap();
        let mut ssh = device("ssh-device", "ssh", "auto");
        ssh.port = Some(65_535);
        ssh.private_key_enc = Some(private_key_ciphertext.clone());
        ssh.password_enc = Some("stale-invalid-password-ciphertext".to_owned());
        repository.create_device(ssh).await.unwrap();

        let spawn_policy: Arc<dyn SpawnPolicy> = Arc::new(TestSpawnPolicy);
        let transport_factory = Arc::new(CapturingTransportFactory::default());
        let factory = RepositoryTmuxRuntimeFactory::with_transport_factory(
            repository,
            key,
            spawn_policy.clone(),
            factory_config(),
            transport_factory.clone(),
        );

        let local_error = TmuxRuntimeFactory::create(&factory, "local-device".to_owned())
            .await
            .err()
            .expect("capturing transport rejects runtime start");
        assert!(local_error.message.contains("tmux_runtime_start_failed"));
        let ssh_error = TmuxRuntimeFactory::create(&factory, "ssh-device".to_owned())
            .await
            .err()
            .expect("capturing transport rejects runtime start");
        assert!(ssh_error.message.contains("tmux_runtime_start_failed"));

        let configs = transport_factory.configs.lock().unwrap();
        let local = &configs[0];
        assert_eq!(local.device_name, None);
        assert_eq!(local.session_name, "tmex");
        assert_eq!(local.default_working_dir, None);
        assert!(Arc::ptr_eq(&local.spawn_policy, &spawn_policy));
        let TmuxTransportConfig::Local(local_transport) = &local.transport else {
            panic!("expected local transport");
        };
        assert_eq!(local_transport.tmux_bin, "custom-tmux");
        assert_eq!(local_transport.socket_name, None);
        assert_eq!(local_transport.environment["HOME"], "/home/test");

        let ssh = &configs[1];
        assert_eq!(ssh.device_name.as_deref(), Some("Workstation"));
        assert_eq!(ssh.session_name, "session-one");
        assert_eq!(ssh.default_working_dir.as_deref(), Some("/workspace"));
        assert!(Arc::ptr_eq(&ssh.spawn_policy, &spawn_policy));
        let TmuxTransportConfig::Ssh(ssh_transport) = &ssh.transport else {
            panic!("expected SSH transport");
        };
        assert_eq!(ssh_transport.port, Some(65_535));
        assert_eq!(ssh_transport.auth_mode, SshAuthMode::Auto);
        assert_eq!(
            ssh_transport.private_key.as_ref().unwrap().expose(),
            private_key_plaintext
        );
        assert!(ssh_transport.password.is_none());
        assert!(ssh_transport.private_key_passphrase.is_none());

        let debug = format!("{ssh:?}");
        assert!(!debug.contains(private_key_plaintext));
        assert!(!debug.contains(&private_key_ciphertext));
        assert!(!ssh_error.message.contains(private_key_plaintext));
        assert!(!ssh_error.message.contains(&private_key_ciphertext));
    }

    #[tokio::test]
    async fn rejects_missing_invalid_port_and_corrupt_secret_with_redacted_errors() {
        let repository = test_repository().await;
        let key = MasterKey::development_default();
        let spawn_policy: Arc<dyn SpawnPolicy> = Arc::new(TestSpawnPolicy);
        let transport_factory = Arc::new(CapturingTransportFactory::default());
        let factory = RepositoryTmuxRuntimeFactory::with_transport_factory(
            repository.clone(),
            key.clone(),
            spawn_policy,
            factory_config(),
            transport_factory,
        );

        let missing = TmuxRuntimeFactory::create(&factory, "missing".to_owned())
            .await
            .err()
            .expect("missing device is rejected");
        assert!(missing.message.contains("tmux_device_not_found"));

        let mut invalid_port = device("invalid-port", "ssh", "agent");
        invalid_port.port = Some(65_536);
        repository.create_device(invalid_port).await.unwrap();
        let invalid_port = TmuxRuntimeFactory::create(&factory, "invalid-port".to_owned())
            .await
            .err()
            .expect("invalid SSH port is rejected");
        assert!(invalid_port.message.contains("tmux_ssh_port_invalid"));

        let ciphertext_marker = "ciphertext-must-not-leak";
        let mut corrupt = device("corrupt-secret", "ssh", "password");
        corrupt.password_enc = Some(ciphertext_marker.to_owned());
        repository.create_device(corrupt).await.unwrap();
        let corrupt = RepositoryTmuxRuntimeFactory::with_transport_factory(
            repository,
            key,
            Arc::new(TestSpawnPolicy),
            factory_config(),
            Arc::new(CapturingTransportFactory::default()),
        );
        let error = TmuxRuntimeFactory::create(&corrupt, "corrupt-secret".to_owned())
            .await
            .err()
            .expect("corrupt credential is rejected");
        assert!(error
            .message
            .contains("device id=corrupt-secret field=password_enc"));
        assert!(!error.message.contains(ciphertext_marker));
    }
}
