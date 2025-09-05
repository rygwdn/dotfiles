use clap::{ArgMatches, Command};
use serde_json;
use world_nav::config::ConfigManager;

pub fn command() -> Command {
    Command::new("config")
        .about("Display the current configuration and config file path")
        .long_about("Display the current configuration and config file path.\nThe configuration includes world paths, source paths, depth limits, and database locations.")
}

pub fn handle(_matches: &ArgMatches) {
    let config_path = ConfigManager::get_config_path();
    let config = ConfigManager::load_config();

    println!("Config file: {}", config_path.display());

    if !config_path.exists() {
        println!("Note: Config file does not exist, using defaults");
    }

    println!("\nCurrent configuration:");

    match serde_json::to_string_pretty(&config) {
        Ok(json) => println!("{}", json),
        Err(e) => {
            eprintln!("Error serializing config: {}", e);
            std::process::exit(1);
        }
    }
}
