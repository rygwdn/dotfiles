use clap::{Arg, ArgAction, Command};
use std::env;
use worktree_util::{shell_init, WorktreeNavigator};

fn main() {
    let matches = Command::new("worktree-nav")
        .version(env!("CARGO_PKG_VERSION"))
        .about("WorktreeNavigator - Fast fuzzy path navigation for development workflows")
        .arg(
            Arg::new("init")
                .long("init")
                .help("Output shell integration script (format: shell or shell:function_name)")
                .value_name("SHELL[:NAME]")
                .conflicts_with_all(["list", "scores", "filter", "query"]),
        )
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
            Arg::new("query")
                .help("Search query")
                .trailing_var_arg(true)
                .num_args(0..),
        )
        .get_matches();

    // Handle --init flag
    if let Some(init_value) = matches.get_one::<String>("init") {
        let parts: Vec<&str> = init_value.split(':').collect();
        let shell = parts[0];
        let function_name = parts.get(1).unwrap_or(&"wl");

        // Validate function name for fish
        if !function_name
            .chars()
            .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
        {
            eprintln!("Error: Function name '{}' contains invalid characters. Use only letters, numbers, underscores, and hyphens.", function_name);
            std::process::exit(1);
        }

        let exe_path = match env::current_exe() {
            Ok(path) => path.display().to_string(),
            Err(_) => "worktree-nav".to_string(),
        };

        let init_script = match shell {
            "fish" => shell_init::get_fish_init(&exe_path, function_name),
            "bash" => shell_init::get_bash_init(&exe_path, function_name),
            "zsh" => shell_init::get_zsh_init(&exe_path, function_name),
            _ => {
                eprintln!("Unsupported shell: {}", shell);
                std::process::exit(1);
            }
        };

        println!("{}", init_script);
        return;
    }

    let navigator = WorktreeNavigator::new();
    let show_scores = matches.get_flag("scores");

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
        navigate(&navigator, &query, show_scores);
    }
}

fn filter_output(navigator: &WorktreeNavigator, query: &str, show_scores: bool) {
    let paths = navigator.list(query, show_scores);
    for path in paths {
        println!("{}", path);
    }
}

fn navigate(navigator: &WorktreeNavigator, query: &str, show_scores: bool) {
    if let Some(path) = navigator.navigate(query, show_scores) {
        println!("{}", path);
    }
}
