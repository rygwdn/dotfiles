use clap::{Arg, ArgAction, Command};
use std::env;
use worktree_util::{shell_init, WorktreeNavigator};

pub fn command() -> Command {
    Command::new("nav")
        .about("WorktreeNavigator - Fast fuzzy path navigation for development workflows")
        .arg(
            Arg::new("shell")
                .long("shell")
                .help("Shell type (defaults to $SHELL)")
                .value_name("SHELL")
                .global(true),
        )
        .arg(
            Arg::new("init-navigate")
                .long("init-navigate")
                .help("Output shell integration script for navigation")
                .value_name("FUNCTION_NAME")
                .num_args(0..=1)
                .default_missing_value("wl")
                .conflicts_with_all(["list", "scores", "filter", "query", "multi"]),
        )
        .arg(
            Arg::new("init-code")
                .long("init-code")
                .help("Output shell integration script for VS Code multi-select")
                .value_name("FUNCTION_NAME")
                .num_args(0..=1)
                .default_missing_value("jc")
                .conflicts_with_all(["list", "scores", "filter", "query", "multi"]),
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
    // Handle init flags
    let has_init_navigate = matches.contains_id("init-navigate");
    let has_init_code = matches.contains_id("init-code");

    if has_init_navigate || has_init_code {
        let output = generate_init_scripts(matches);
        println!("{}", output);
        return;
    }

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

fn get_shell_type(matches: &clap::ArgMatches) -> String {
    matches
        .get_one::<String>("shell")
        .cloned()
        .or_else(|| {
            env::var("SHELL")
                .ok()
                .and_then(|shell_path| shell_path.split('/').last().map(|s| s.to_string()))
        })
        .unwrap_or_else(|| "bash".to_string())
}

fn generate_init_scripts(matches: &clap::ArgMatches) -> String {
    let exe_path = match env::current_exe() {
        Ok(path) => path.display().to_string(),
        Err(_) => "worktree-util".to_string(),
    };

    let shell = get_shell_type(matches);
    let mut output = String::new();

    // Define init configurations with their corresponding flag names
    let init_configs = vec![
        ("init-navigate", &shell_init::NAVIGATION_CONFIG),
        ("init-code", &shell_init::CODE_CONFIG),
    ];

    let mut first = true;
    for (flag_name, config) in init_configs {
        if matches.contains_id(flag_name) {
            let function_name = matches.get_one::<String>(flag_name).map(|s| s.as_str());

            if !first {
                output.push_str("\n\n");
            }
            first = false;

            // Update the command to use 'nav' subcommand
            let updated_exe_path = format!("{} nav", exe_path);
            match shell_init::get_shell_init(&shell, &updated_exe_path, function_name, config) {
                Ok(script) => output.push_str(&script),
                Err(e) => {
                    eprintln!("Error: {}", e);
                    std::process::exit(1);
                }
            }
        }
    }

    output
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