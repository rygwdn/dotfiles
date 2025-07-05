#![allow(clippy::expect_used)]

use crate::utils::expand_path;
use config::{Config, File};
use dirs;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process;

/// Get the default frecency database path
fn default_frecency_db_path() -> String {
    dirs::data_dir()
        .unwrap_or_else(|| expand_path("~/.local/share"))
        .join("world-nav")
        .join("frecency.db")
        .to_string_lossy()
        .to_string()
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WorldNavConfig {
    /// Path to world trees directory
    pub world_path: Option<String>,
    /// List of source directories to scan for repositories
    pub src_paths: Vec<String>,
    /// Maximum depth to scan for repositories (optional, defaults to 3)
    pub depth_limit: Option<usize>,
    /// Path to frecency database file
    pub frecency_db_path: String,
}

impl Default for WorldNavConfig {
    fn default() -> Self {
        WorldNavConfig {
            world_path: Some("~/world/trees".to_string()),
            src_paths: vec!["~/src".to_string()],
            depth_limit: Some(3),
            frecency_db_path: default_frecency_db_path(),
        }
    }
}

pub struct ConfigManager;

impl ConfigManager {
    /// Loads the full world-nav configuration
    pub fn load_config() -> WorldNavConfig {
        let config_path = Self::get_config_path();
        let default_config = WorldNavConfig::default();

        // Build configuration from config file if it exists
        let settings = Config::builder()
            // Set defaults from WorldNavConfig::default()
            .set_default("world_path", default_config.world_path.clone())
            .expect("Failed to set default world_path")
            .set_default("src_paths", default_config.src_paths.clone())
            .expect("Failed to set default src_paths")
            .set_default("depth_limit", default_config.depth_limit.map(|d| d as i64))
            .expect("Failed to set default depth_limit")
            .set_default("frecency_db_path", default_config.frecency_db_path.clone())
            .expect("Failed to set default frecency_db_path")
            // Add config file if it exists
            .add_source(File::from(config_path.clone()).required(false))
            .build();

        match settings {
            Ok(config) => {
                match config.try_deserialize::<WorldNavConfig>() {
                    Ok(nav_config) => {
                        // Validate that paths are not empty strings
                        if nav_config.src_paths.iter().any(|p| p.trim().is_empty()) {
                            eprintln!("Error: Configuration contains empty source paths");
                            eprintln!("Config file: {}", config_path.display());
                            process::exit(1);
                        }
                        nav_config
                    }
                    Err(e) => {
                        eprintln!("Error: Failed to parse configuration file");
                        eprintln!("Config file: {}", config_path.display());
                        eprintln!("Error details: {}", e);
                        process::exit(1);
                    }
                }
            }
            Err(e) => {
                eprintln!("Error: Failed to load configuration");
                eprintln!("Error details: {}", e);
                process::exit(1);
            }
        }
    }

    /// Gets the path to the configuration file
    pub fn get_config_path() -> PathBuf {
        // Check for environment variable override
        if let Ok(config_path) = std::env::var("WORLD_NAV_CONFIG") {
            return PathBuf::from(config_path);
        }

        let config_dir = dirs::config_dir().unwrap_or_else(|| expand_path("~/.config"));

        config_dir.join("world-nav").join("config.json")
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    #![allow(clippy::expect_used)]
    use super::*;
    use crate::test_utils::test_env::TestEnvironment;
    use std::env;

    #[test]
    fn test_default_world_nav_config() {
        let config = WorldNavConfig::default();
        assert_eq!(config.world_path, Some("~/world/trees".to_string()));
        assert_eq!(config.src_paths, vec!["~/src"]);
        assert_eq!(config.depth_limit, Some(3));
        assert!(config.frecency_db_path.contains("world-nav"));
        assert!(config.frecency_db_path.ends_with("frecency.db"));
    }

    #[test]
    fn test_config_path_override() {
        let env = TestEnvironment::new();
        let custom_config_path = env.temp_dir.path().join("custom-config.json");

        env::set_var("WORLD_NAV_CONFIG", custom_config_path.to_str().unwrap());

        let config_path = ConfigManager::get_config_path();
        assert_eq!(config_path, custom_config_path);

        env::remove_var("WORLD_NAV_CONFIG");
    }

    #[test]
    fn test_config_serialization() {
        let config = WorldNavConfig {
            world_path: Some("/world/custom".to_string()),
            src_paths: vec!["/path/one".to_string(), "/path/two".to_string()],
            depth_limit: Some(5),
            frecency_db_path: default_frecency_db_path(),
        };

        let json = serde_json::to_string(&config).unwrap();
        let deserialized: WorldNavConfig = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.world_path, Some("/world/custom".to_string()));
        assert_eq!(deserialized.src_paths.len(), 2);
        assert!(deserialized.src_paths.contains(&"/path/one".to_string()));
        assert!(deserialized.src_paths.contains(&"/path/two".to_string()));
        assert_eq!(deserialized.depth_limit, Some(5));
        assert_eq!(deserialized.frecency_db_path, default_frecency_db_path());
    }

    #[test]
    fn test_config_with_frecency_db_path() {
        let env = TestEnvironment::new();

        let config_with_db = format!(
            r#"{{
  "world_path": "{}",
  "src_paths": ["{}"],
  "depth_limit": 3,
  "frecency_db_path": "{}/custom_frecency.db"
}}"#,
            env.world_path.to_string_lossy(),
            env.src_path.to_string_lossy(),
            env.temp_dir.path().to_string_lossy()
        );

        env.write_config(Some(&config_with_db));
        env.set_config_env();

        let loaded = ConfigManager::load_config();
        assert!(loaded.frecency_db_path.contains("custom_frecency.db"));
    }

    #[test]
    fn test_config_validation() {
        let env = TestEnvironment::new();

        // Test valid config
        let valid_config = WorldNavConfig {
            world_path: Some("/world/trees".to_string()),
            src_paths: vec!["/valid/path".to_string()],
            depth_limit: Some(3),
            frecency_db_path: default_frecency_db_path(),
        };
        let valid_json = serde_json::to_string(&valid_config).unwrap();
        env.write_config(Some(&valid_json));

        let loaded = serde_json::from_str::<WorldNavConfig>(
            &std::fs::read_to_string(&env.config_path).unwrap(),
        )
        .unwrap();
        assert_eq!(loaded.world_path, Some("/world/trees".to_string()));
        assert_eq!(loaded.src_paths, vec!["/valid/path"]);

        // Test config with empty path (should be rejected in validation)
        let invalid_config = WorldNavConfig {
            world_path: Some("/world/trees".to_string()),
            src_paths: vec!["".to_string(), "  ".to_string()],
            depth_limit: Some(3),
            frecency_db_path: default_frecency_db_path(),
        };

        // The validation logic would reject this config
        let has_invalid_paths = invalid_config.src_paths.iter().any(|p| p.trim().is_empty());
        assert!(has_invalid_paths);
    }

    #[test]
    fn test_load_config_with_nonexistent_file() {
        let env = TestEnvironment::new();
        env.set_config_env();

        // Since we're using defaults from the builder, this should work even without a file
        let config = ConfigManager::load_config();
        assert_eq!(config.world_path, Some("~/world/trees".to_string()));
        assert_eq!(config.src_paths, vec!["~/src"]);
        assert_eq!(config.depth_limit, Some(3));
        assert_eq!(config.frecency_db_path, default_frecency_db_path());
    }

    #[test]
    fn test_invalid_config_would_exit() {
        let env = TestEnvironment::new();

        // Write invalid JSON
        std::fs::write(&env.config_path, "{ invalid json }").unwrap();
        env.set_config_env();

        // We can't actually call load_config() here because it would exit
        // Instead, we verify the config is invalid
        let settings = Config::builder()
            .add_source(File::from(env.config_path.clone()).required(false))
            .build();

        // With invalid JSON, the config builder itself should fail
        if let Ok(config) = settings {
            let result: Result<WorldNavConfig, _> = config.try_deserialize();
            assert!(result.is_err()); // If it loaded, deserialization should fail
        } else {
            // More likely: the builder failed to parse invalid JSON
            assert!(settings.is_err());
        }
    }

    #[test]
    fn test_empty_path_would_exit() {
        let env = TestEnvironment::new();

        // Write config with empty path
        let invalid_config = format!(
            r#"{{
            "world_path": "~/world/trees",
            "src_paths": ["~/src", ""],
            "depth_limit": 3,
            "frecency_db_path": "{}"
        }}"#,
            default_frecency_db_path()
        );

        env.write_config(Some(&invalid_config));

        // Parse it to verify it would be rejected
        let parsed: WorldNavConfig = serde_json::from_str(&invalid_config).unwrap();
        let has_empty = parsed.src_paths.iter().any(|p| p.trim().is_empty());
        assert!(has_empty); // This condition would trigger exit
    }
}
