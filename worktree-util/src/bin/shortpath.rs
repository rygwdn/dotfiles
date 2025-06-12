use clap::{Arg, ArgAction, Command};
use std::env;
use std::io::{self, BufRead, BufReader};
use std::path::PathBuf;
use worktree_util::shorten_path;

#[allow(clippy::expect_used)]
fn main() {
    let matches = Command::new("shortpath")
        .version(env!("CARGO_PKG_VERSION"))
        .about("Shortens paths for shell prompts")
        .arg(
            Arg::new("max_segments")
                .short('n')
                .long("max-segments")
                .value_name("MAX_SEGMENTS")
                .help("Number of segments to keep unshortened (default: 1)")
                .default_value("1"),
        )
        .arg(
            Arg::new("section")
                .short('s')
                .long("section")
                .value_name("SECTION")
                .help("Section(s) to output (prefix, shortened, normal, full). Can be comma-separated for multiple sections.")
                .default_value("full"),
        )
        .arg(
            Arg::new("stdin")
                .long("stdin")
                .help("Read paths from stdin (one per line) and output shortened paths")
                .action(ArgAction::SetTrue),
        )
        .arg(
            Arg::new("path")
                .value_name("PATH")
                .help("Path to shorten (default: current directory)")
                .default_value(".")
                .action(ArgAction::Set)
                .required(false),
        )
        .get_matches();

    let max_segments = matches
        .get_one::<String>("max_segments")
        .expect("max_segments has a default value")
        .parse::<usize>()
        .unwrap_or(1);
    let section = matches
        .get_one::<String>("section")
        .expect("section has a default value");
    let use_stdin = matches.get_flag("stdin");

    // Parse comma-separated sections
    let sections: Vec<&str> = section.split(',').map(|s| s.trim()).collect();

    // Validate sections
    let valid_sections = ["prefix", "shortened", "normal", "full"];
    for s in &sections {
        if !valid_sections.contains(s) {
            eprintln!(
                "Error: Invalid section '{}'. Valid sections are: prefix, shortened, normal, full",
                s
            );
            std::process::exit(1);
        }
    }

    // Validate that multiple sections are only used without stdin
    if use_stdin && sections.len() > 1 {
        eprintln!("Error: Multiple sections are not supported with --stdin");
        std::process::exit(1);
    }

    if use_stdin {
        // Batch mode: read paths from stdin
        let stdin = io::stdin();
        let reader = BufReader::new(stdin);

        for path in reader.lines().map_while(Result::ok) {
            let path_to_shorten = expand_path(&path);
            let short_path = shorten_path(&path_to_shorten);

            // stdin mode only supports single section
            match sections[0] {
                "prefix" => println!("{}", short_path.prefix(max_segments)),
                "shortened" => println!("{}", short_path.shortened(max_segments)),
                "normal" => println!("{}", short_path.normal(max_segments)),
                _ => println!("{}", short_path.full(max_segments)),
            }
        }
    } else {
        // Single path mode
        let path = matches.get_one::<String>("path").expect("path is required");
        let path_to_shorten = expand_path(path);
        let short_path = shorten_path(&path_to_shorten);

        for part in sections.iter() {
            match *part {
                "all" => {
                    println!("Full:       {}", short_path.full(max_segments));
                    println!("Prefix:     {}", short_path.prefix(max_segments));
                    println!("Shortened:  {}", short_path.shortened(max_segments));
                    println!("Normal:     {}", short_path.normal(max_segments));
                }
                "full" => println!("{}", short_path.full(max_segments)),
                "prefix" => println!("{}", short_path.prefix(max_segments)),
                "shortened" => println!("{}", short_path.shortened(max_segments)),
                "normal" => println!("{}", short_path.normal(max_segments)),
                _ => eprintln!("Unknown part: {}", part),
            }
        }
    }
}

fn expand_path(path: &str) -> PathBuf {
    let path_buf = if path == "." {
        env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else {
        PathBuf::from(path)
    };

    if let Ok(canonical) = path_buf.canonicalize() {
        canonical
    } else {
        path_buf
    }
}
