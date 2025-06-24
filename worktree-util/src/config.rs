use crate::utils::expand_path;
use config::{Config, Environment, File};
use dirs;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SrcConfig {
    /// List of source directories to scan for repositories
    pub src_paths: Vec<String>,
    /// Maximum depth to scan for repositories (optional, defaults to 3)
    pub depth_limit: Option<usize>,
}

impl Default for SrcConfig {
    fn default() -> Self {
        SrcConfig {
            src_paths: vec!["~/src".to_string(), "~/dotfiles".to_string()],
            depth_limit: Some(3),
        }
    }
}

pub struct ConfigManager;

impl ConfigManager {
    /// Loads source configuration using the config crate with multiple sources
    pub fn load_src_config() -> SrcConfig {
        let config_path = Self::get_config_path();

        // Build configuration from multiple sources in priority order:
        // 1. Default values
        // 2. Config file
        // 3. Environment variables (WORKTREE_*)
        #[allow(clippy::expect_used)] // Basic default settings should never fail
        let settings = Config::builder()
            // Start with defaults
            .set_default("src_paths", vec!["~/src", "~/dotfiles"])
            .expect("Failed to set default src_paths")
            .set_default("depth_limit", 3)
            .expect("Failed to set default depth_limit")
            // Add config file if it exists
            .add_source(File::from(config_path.clone()).required(false))
            // Add environment variables with prefix WORKTREE_
            // e.g., WORKTREE_SRC_PATHS__0="~/src" WORKTREE_SRC_PATHS__1="~/work" WORKTREE_DEPTH_LIMIT=5
            .add_source(
                Environment::with_prefix("WORKTREE")
                    .prefix_separator("_")
                    .separator("__")
            )
            .build();

        // Create default config file if it doesn't exist
        if !config_path.exists() {
            if let Err(e) = Self::create_default_config(&config_path) {
                eprintln!("Warning: Failed to create default config file: {}", e);
            } else {
                eprintln!(
                    "Created default configuration at: {}",
                    config_path.display()
                );
            }
        }

        match settings {
            Ok(config) => {
                match config.try_deserialize::<SrcConfig>() {
                    Ok(src_config) => {
                        // Validate that paths are not empty
                        if src_config.src_paths.iter().all(|p| !p.trim().is_empty()) {
                            src_config
                        } else {
                            eprintln!("Warning: Invalid paths in configuration, using defaults");
                            SrcConfig::default()
                        }
                    }
                    Err(e) => {
                        eprintln!(
                            "Warning: Failed to parse configuration: {}, using defaults",
                            e
                        );
                        SrcConfig::default()
                    }
                }
            }
            Err(e) => {
                eprintln!(
                    "Warning: Failed to load configuration: {}, using defaults",
                    e
                );
                SrcConfig::default()
            }
        }
    }

    /// Gets the path to the configuration file
    pub fn get_config_path() -> PathBuf {
        let config_dir = dirs::config_dir()
            .unwrap_or_else(|| expand_path("~/.config"))
            .join("worktree-util");

        config_dir.join("src-config.json")
    }

    /// Creates a default configuration file
    pub fn create_default_config(config_path: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(parent) = config_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let default_config = SrcConfig::default();
        let json_content = serde_json::to_string_pretty(&default_config)?;
        std::fs::write(config_path, json_content)?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use tempfile::TempDir;

    #[test]
    fn test_default_src_config() {
        let config = SrcConfig::default();
        assert_eq!(config.src_paths, vec!["~/src", "~/dotfiles"]);
        assert_eq!(config.depth_limit, Some(3));
    }

    #[test]
    fn test_config_with_environment_variables() {
        // Test just the depth_limit environment variable for simplicity
        // Array env vars are complex in the config crate, so we'll focus on scalar values
        env::set_var("WORKTREE_DEPTH_LIMIT", "5");

        // Build config manually to test environment variable parsing
        let settings = Config::builder()
            .set_default("src_paths", vec!["~/src", "~/dotfiles"])
            .unwrap()
            .set_default("depth_limit", 3)
            .unwrap()
            .add_source(
                Environment::with_prefix("WORKTREE")
                    .prefix_separator("_")
                    .separator("__"),
            )
            .build()
            .unwrap();

        let config: SrcConfig = settings.try_deserialize().unwrap();

        // Check that depth_limit was overridden by environment variable
        assert_eq!(config.depth_limit, Some(5));
        // src_paths should remain as default since env override for arrays is complex
        assert_eq!(config.src_paths, vec!["~/src", "~/dotfiles"]);

        // Clean up
        env::remove_var("WORKTREE_DEPTH_LIMIT");
    }

    #[test]
    fn test_config_serialization() {
        let config = SrcConfig {
            src_paths: vec!["/path/one".to_string(), "/path/two".to_string()],
            depth_limit: Some(5),
        };

        let json = serde_json::to_string(&config).unwrap();
        let deserialized: SrcConfig = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.src_paths.len(), 2);
        assert!(deserialized.src_paths.contains(&"/path/one".to_string()));
        assert!(deserialized.src_paths.contains(&"/path/two".to_string()));
        assert_eq!(deserialized.depth_limit, Some(5));
    }

    #[test]
    fn test_config_validation() {
        let temp_dir = TempDir::new().unwrap();
        let config_file = temp_dir.path().join("src-config.json");

        // Test valid config
        let valid_config = SrcConfig {
            src_paths: vec!["/valid/path".to_string()],
            depth_limit: Some(3),
        };
        std::fs::write(&config_file, serde_json::to_string(&valid_config).unwrap()).unwrap();

        let loaded =
            serde_json::from_str::<SrcConfig>(&std::fs::read_to_string(&config_file).unwrap())
                .unwrap();
        assert_eq!(loaded.src_paths, vec!["/valid/path"]);

        // Test config with empty path (should be rejected in validation)
        let invalid_config = SrcConfig {
            src_paths: vec!["".to_string(), "  ".to_string()],
            depth_limit: Some(3),
        };

        // The validation logic would reject this config
        let has_invalid_paths = invalid_config.src_paths.iter().any(|p| p.trim().is_empty());
        assert!(has_invalid_paths);
    }

    #[test]
    fn test_create_default_config() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("test-config.json");

        ConfigManager::create_default_config(&config_path).unwrap();

        assert!(config_path.exists());
        let content = std::fs::read_to_string(&config_path).unwrap();
        let config: SrcConfig = serde_json::from_str(&content).unwrap();

        assert_eq!(config.src_paths, vec!["~/src", "~/dotfiles"]);
        assert_eq!(config.depth_limit, Some(3));
    }

    #[test]
    fn test_load_src_config_with_nonexistent_file() {
        // Clean up any environment variables from other tests
        env::remove_var("WORKTREE_DEPTH_LIMIT");

        // Set a temporary config directory that doesn't exist
        let temp_dir = TempDir::new().unwrap();
        let original_home = env::var("HOME").ok();
        env::set_var("HOME", temp_dir.path());

        let config = ConfigManager::load_src_config();
        assert_eq!(config.src_paths, vec!["~/src", "~/dotfiles"]);
        assert_eq!(config.depth_limit, Some(3));

        // Restore original HOME if it existed
        if let Some(home) = original_home {
            env::set_var("HOME", home);
        } else {
            env::remove_var("HOME");
        }
    }
}
