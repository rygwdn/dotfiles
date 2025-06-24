use clap::{Arg, ArgAction, Command};
use worktree_util::WorktreeNavigator;

pub fn command() -> Command {
    Command::new("nav")
        .about("WorktreeNavigator - Fast fuzzy path navigation for development workflows")
        .arg(
            Arg::new("list")
                .long("list")
                .help("List all paths")
                .action(ArgAction::SetTrue),
        )
        .arg(
            Arg::new("scores")
                .long("scores")
                .help("Include scores in output")
                .action(ArgAction::SetTrue),
        )
        .arg(
            Arg::new("filter")
                .long("filter")
                .help("Filter paths (for fzf callback)")
                .action(ArgAction::SetTrue),
        )
        .arg(
            Arg::new("multi")
                .long("multi")
                .help("Enable multi-selection mode")
                .action(ArgAction::SetTrue),
        )
        .arg(
            Arg::new("query")
                .help("Search query")
                .trailing_var_arg(true)
                .num_args(0..),
        )
}

pub fn handle(matches: &clap::ArgMatches) {
    let navigator = WorktreeNavigator::new();
    let show_scores = matches.get_flag("scores");
    let multi = matches.get_flag("multi");

    if matches.get_flag("list") {
        filter_output(&navigator, "", show_scores);
    } else if matches.get_flag("filter") {
        let query = matches
            .get_many::<String>("query")
            .map(|values| values.map(|s| s.as_str()).collect::<Vec<_>>().join(" "))
            .unwrap_or_default();
        filter_output(&navigator, &query, show_scores);
    } else {
        let query = matches
            .get_many::<String>("query")
            .map(|values| values.map(|s| s.as_str()).collect::<Vec<_>>().join(" "))
            .unwrap_or_default();
        navigate(&navigator, &query, show_scores, multi);
    }
}

fn filter_output(navigator: &WorktreeNavigator, query: &str, show_scores: bool) {
    let paths = navigator.list(query, show_scores);
    for path in paths {
        println!("{}", path);
    }
}

fn navigate(navigator: &WorktreeNavigator, query: &str, show_scores: bool, multi: bool) {
    let prompt = if multi {
        "(Multi-select with TAB/Shift-TAB) > "
    } else {
        "> "
    };

    let paths = navigator.navigate(query, show_scores, multi, prompt);

    // For non-interactive mode or when paths are selected
    for path in paths {
        println!("{}", path);
    }
}
