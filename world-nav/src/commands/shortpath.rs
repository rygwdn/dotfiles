#![allow(clippy::expect_used)]

use clap::{Arg, ArgAction, Command};
use std::env;
use std::io::{self, BufRead, BufReader};
use std::path::PathBuf;
use world_nav::shorten_path;
use world_nav::ShortPathPart::*;

pub fn command() -> Command {
    Command::new("shortpath")
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
                .help("Section(s) to output (prefix, shortened, normal, full, colored). Can be comma-separated for multiple sections.")
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
}

pub fn handle(matches: &clap::ArgMatches) {
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
    let valid_sections = ["prefix", "shortened", "normal", "full", "colored", "all"];
    for s in &sections {
        if !valid_sections.contains(s) {
            eprintln!(
                "Error: Invalid section '{s}'. Valid sections are: prefix, shortened, normal, full, colored, all"
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
                "prefix" => println!("{}", short_path.build(max_segments, &[Prefix])),
                "shortened" => println!("{}", short_path.build(max_segments, &[Infix])),
                "normal" => println!("{}", short_path.build(max_segments, &[Suffix])),
                "colored" => println!("{}", short_path.display(None)),
                _ => println!(
                    "{}",
                    short_path.build(max_segments, &[Prefix, Infix, Suffix])
                ),
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
                    println!(
                        "Full:       {}",
                        short_path.build(max_segments, &[Prefix, Infix, Suffix])
                    );
                    println!("Prefix:     {}", short_path.build(max_segments, &[Prefix]));
                    println!("Shortened:  {}", short_path.build(max_segments, &[Infix]));
                    println!("Normal:     {}", short_path.build(max_segments, &[Suffix]));
                    println!("Colored:    {}", short_path.display(None));
                }
                "full" => println!(
                    "{}",
                    short_path.build(max_segments, &[Prefix, Infix, Suffix])
                ),
                "prefix" => println!("{}", short_path.build(max_segments, &[Prefix])),
                "shortened" => println!("{}", short_path.build(max_segments, &[Infix])),
                "normal" => println!("{}", short_path.build(max_segments, &[Suffix])),
                "colored" => println!("{}", short_path.display(None)),
                _ => eprintln!("Unknown part: {part}"),
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
