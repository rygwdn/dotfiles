use clap::Command;
use std::env;

#[path = "../commands/mod.rs"]
mod commands;

use world_nav::config::ConfigManager;

fn main() {
    let config_path = ConfigManager::get_config_path();
    let long_about = format!(
        "Worktree navigation and path shortening utilities\n\n\
        Config file: {}\n\
        Environment variable: WORLD_NAV_CONFIG",
        config_path.display()
    );

    let app = Command::new("world-nav")
        .version(env!("CARGO_PKG_VERSION"))
        .about("Worktree navigation and path shortening utilities")
        .long_about(long_about)
        .subcommand_required(true)
        .arg_required_else_help(true)
        .subcommand(commands::config::command())
        .subcommand(commands::update_frecency::command())
        .subcommand(commands::shortpath::command())
        .subcommand(commands::nav::command())
        .subcommand(commands::version_check::command())
        .subcommand(commands::shell_init::command());

    let matches = app.get_matches();

    match matches.subcommand() {
        Some(("config", sub_matches)) => commands::config::handle(sub_matches),
        Some(("update-frecency", sub_matches)) => commands::update_frecency::handle(sub_matches),
        Some(("shortpath", sub_matches)) => commands::shortpath::handle(sub_matches),
        Some(("nav", sub_matches)) => commands::nav::handle(sub_matches),
        Some(("version-check", sub_matches)) => commands::version_check::handle(sub_matches),
        Some(("shell-init", sub_matches)) => commands::shell_init::handle_from_matches(sub_matches),
        _ => unreachable!("Subcommand required"),
    }
}
