#![allow(clippy::expect_used)]

use clap::{Arg, ArgAction, Command};
use semver::{Version, VersionReq};
use std::env;

pub fn command() -> Command {
    Command::new("version-check")
        .about("Check version compatibility using semver rules")
        .arg(
            Arg::new("required_version")
                .value_name("VERSION")
                .help("Required version (supports semver requirements like '^0.3.0', '~0.3.0', '>=0.2.0')")
                .required(true),
        )
        .arg(
            Arg::new("quiet")
                .short('q')
                .long("quiet")
                .help("Suppress output, only return exit code")
                .action(ArgAction::SetTrue),
        )
}

pub fn handle(matches: &clap::ArgMatches) {
    let required_version_str = matches
        .get_one::<String>("required_version")
        .expect("required_version is required");
    let quiet = matches.get_flag("quiet");

    let current_version_str = env!("CARGO_PKG_VERSION");

    // Parse current version
    let current_version = match Version::parse(current_version_str) {
        Ok(v) => v,
        Err(e) => {
            if !quiet {
                eprintln!("Error: Invalid current version '{current_version_str}': {e}");
            }
            std::process::exit(1);
        }
    };

    // Parse required version requirement
    let version_req = match VersionReq::parse(required_version_str) {
        Ok(req) => req,
        Err(e) => {
            if !quiet {
                eprintln!("Error: Invalid version requirement '{required_version_str}': {e}");
            }
            std::process::exit(1);
        }
    };

    // Check if current version satisfies the requirement
    let is_compatible = version_req.matches(&current_version);

    if !quiet {
        if is_compatible {
            println!("✓ Version {current_version} satisfies requirement {version_req}");
        } else {
            println!("✗ Version {current_version} does not satisfy requirement {version_req}");
        }
    }

    if !is_compatible {
        std::process::exit(1);
    }
}
