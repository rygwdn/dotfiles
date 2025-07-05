use clap::Command;
use std::env;

#[path = "../commands/mod.rs"]
mod commands;

fn main() {
    let app = Command::new("worktree-util")
        .version(env!("CARGO_PKG_VERSION"))
        .about("Worktree navigation and path shortening utilities")
        .subcommand_required(true)
        .arg_required_else_help(true)
        .subcommand(commands::shortpath::command())
        .subcommand(commands::nav::command())
        .subcommand(commands::version_check::command())
        .subcommand(commands::shell_init::command());

    let matches = app.get_matches();

    match matches.subcommand() {
        Some(("shortpath", sub_matches)) => commands::shortpath::handle(sub_matches),
        Some(("nav", sub_matches)) => commands::nav::handle(sub_matches),
        Some(("version-check", sub_matches)) => commands::version_check::handle(sub_matches),
        Some(("shell-init", sub_matches)) => commands::shell_init::handle_from_matches(sub_matches),
        _ => unreachable!("Subcommand required"),
    }
}
