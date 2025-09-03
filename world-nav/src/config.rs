#![allow(clippy::expect_used)]

use crate::utils::expand_path;
use config::{Config, File};
use dirs;
use serde::{Deserialize, Serialize};
use std::fs;
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
    /// Creates the default config file if it doesn't exist
    pub fn create_default_config_if_missing() -> Result<(), std::io::Error> {
        let config_path = Self::get_config_path();

        // Check if config file already exists
        if config_path.exists() {
            return Ok(());
        }

        // Create parent directories if they don't exist
        if let Some(parent) = config_path.parent() {
            fs::create_dir_all(parent)?;
        }

        // Create default config
        let default_config = WorldNavConfig::default();
        let json = serde_json::to_string_pretty(&default_config)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;

        // Write to file
        fs::write(&config_path, json)?;

        Ok(())
    }

    /// Loads the full world-nav configuration
    pub fn load_config() -> WorldNavConfig {
        Self::load_config_with_options(true)
    }

    /// Loads the full world-nav configuration with options
    pub fn load_config_with_options(create_if_missing: bool) -> WorldNavConfig {
        let config_path = Self::get_config_path();
        let default_config = WorldNavConfig::default();

        // Create default config file if it doesn't exist
        if create_if_missing && !config_path.exists() {
            if let Err(e) = Self::create_default_config_if_missing() {
                eprintln!(
                    "Error: Failed to create default config file at {}: {}",
                    config_path.display(),
                    e
                );
            }
        }

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
                        eprintln!("Error details: {e}");
                        process::exit(1);
                    }
                }
            }
            Err(e) => {
                eprintln!("Error: Failed to load configuration");
                eprintln!("Error details: {e}");
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
