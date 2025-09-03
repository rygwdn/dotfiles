use clap::Command;
use world_nav::FrecencyDb;

pub fn command() -> Command {
    Command::new("update-frecency")
        .about("Update frecency database for a path")
        .arg(
            clap::Arg::new("path")
                .help("Path to update")
                .required(false)
                .index(1),
        )
        .arg(
            clap::Arg::new("visit")
                .long("visit")
                .help("Record a visit (increment visit count)")
                .action(clap::ArgAction::SetTrue)
                .conflicts_with("access"),
        )
        .arg(
            clap::Arg::new("access")
                .long("access")
                .help("Update access time only (default)")
                .action(clap::ArgAction::SetTrue)
                .conflicts_with("visit"),
        )
}

pub fn handle(matches: &clap::ArgMatches) {
    let path = matches
        .get_one::<String>("path")
        .map(|s| s.as_str())
        .unwrap_or_else(|| ".");

    let is_visit = matches.get_flag("visit");

    let db = FrecencyDb::new();
    let visit_count = if is_visit { 1 } else { 0 };

    if let Err(e) = db.visit(path, visit_count) {
        eprintln!("Error updating frecency database: {e}");
        std::process::exit(1);
    }
}
