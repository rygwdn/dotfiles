#![allow(clippy::expect_used)]

use clap::{ArgMatches, Args, Command, ValueEnum};
use handlebars::Handlebars;
use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::Path;

#[derive(ValueEnum, Clone, Debug)]
pub enum Shell {
    Fish,
    Zsh,
}

#[derive(Args)]
pub struct ShellInitArgs {
    /// Shell type to generate init code for
    #[arg(long, value_enum)]
    pub shell: Shell,

    /// Navigate command name (default: j)
    #[arg(long, default_value = "j")]
    pub navigate: String,

    /// Code command name (default: jc)
    #[arg(long, default_value = "jc")]
    pub code: String,

    /// Required version - either a version string (e.g., "^0.5.1") or path to Cargo.toml
    #[arg(long)]
    pub require_version: Option<String>,

    /// Disable navigation function initialization
    #[arg(long)]
    pub no_navigate: bool,

    /// Disable code function initialization
    #[arg(long)]
    pub no_code: bool,

    /// Disable frecency tracking hook
    #[arg(long)]
    pub no_frecency: bool,

    /// Disable path segment update hook
    #[arg(long)]
    pub no_segments: bool,
}

pub fn command() -> Command {
    Command::new("shell-init")
        .about("Output shell integration code")
        .args(
            ShellInitArgs::augment_args(Command::new("shell-init"))
                .get_arguments()
                .cloned()
                .collect::<Vec<_>>(),
        )
}

pub fn handle_from_matches(matches: &ArgMatches) {
    let shell = matches
        .get_one::<Shell>("shell")
        .cloned()
        .unwrap_or(Shell::Fish);
    let navigate = matches
        .get_one::<String>("navigate")
        .map(|s| s.as_str())
        .unwrap_or("j");
    let code = matches
        .get_one::<String>("code")
        .map(|s| s.as_str())
        .unwrap_or("jc");
    let require_version = matches.get_one::<String>("require_version").cloned();
    let no_navigate = matches.get_flag("no_navigate");
    let no_code = matches.get_flag("no_code");
    let no_frecency = matches.get_flag("no_frecency");
    let no_segments = matches.get_flag("no_segments");

    let args = ShellInitArgs {
        shell,
        navigate: navigate.to_string(),
        code: code.to_string(),
        require_version,
        no_navigate,
        no_code,
        no_frecency,
        no_segments,
    };

    handle(&args).expect("Shell init should not fail")
}

#[derive(Debug, Deserialize, Serialize)]
struct CargoToml {
    package: Package,
}

#[derive(Debug, Deserialize, Serialize)]
struct Package {
    version: String,
}

fn extract_version_from_cargo_toml(path: &Path) -> io::Result<String> {
    let contents = fs::read_to_string(path)?;
    let cargo_toml: CargoToml = toml::from_str(&contents)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;

    Ok(format!("^{}", cargo_toml.package.version))
}

const BUILD_SCRIPT_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/install.sh");

fn check_version_compatibility(require_version: &str) -> bool {
    let current_version_str = env!("CARGO_PKG_VERSION");

    // Parse current version
    let current_version = match Version::parse(current_version_str) {
        Ok(v) => v,
        Err(_) => return false,
    };

    // Parse required version requirement
    let version_req = match VersionReq::parse(require_version) {
        Ok(req) => req,
        Err(_) => return false,
    };

    // Check if current version satisfies the requirement
    version_req.matches(&current_version)
}

fn get_exe_path() -> String {
    match env::current_exe() {
        Ok(path) => path.display().to_string(),
        Err(_) => "world-nav".to_string(),
    }
}

#[allow(clippy::result_large_err)] // Template error size is acceptable for this use case
fn setup_handlebars() -> Result<Handlebars<'static>, handlebars::TemplateError> {
    let mut handlebars = Handlebars::new();

    // Register templates from embedded strings
    handlebars.register_template_string("fish", include_str!("../../templates/fish.fish.hbs"))?;
    handlebars.register_template_string("zsh", include_str!("../../templates/zsh.zsh.hbs"))?;

    Ok(handlebars)
}

fn generate_shell_code(
    args: &ShellInitArgs,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let handlebars = setup_handlebars()?;

    let template_name = match &args.shell {
        Shell::Fish => "fish",
        Shell::Zsh => "zsh",
    };

    let data = json!({
        "init_navigate": !args.no_navigate,
        "init_code": !args.no_code,
        "init_frecency": !args.no_frecency,
        "init_segments": !args.no_segments,
        "navigate_cmd": args.navigate,
        "code_cmd": args.code,
        "exe_path": get_exe_path()
    });

    let rendered = handlebars.render(template_name, &data)?;
    Ok(rendered)
}

pub fn handle(args: &ShellInitArgs) -> io::Result<()> {
    // Determine the required version - check if it's a file path or version string
    let require_version = if let Some(ref version_arg) = args.require_version {
        // Check if it looks like a file path
        let path = Path::new(version_arg);
        if path.exists() && path.extension().is_some_and(|ext| ext == "toml") {
            // It's a path to a TOML file
            Some(extract_version_from_cargo_toml(path).map_err(|e| {
                eprintln!("⚠️  Failed to read version from {version_arg}: {e}");
                e
            })?)
        } else if version_arg.contains('/') || version_arg.contains('\\') {
            // It looks like a path but doesn't exist
            eprintln!("⚠️  Version file not found: {version_arg}");
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("Version file not found: {version_arg}"),
            ));
        } else {
            // It's a version string
            Some(version_arg.clone())
        }
    } else {
        None
    };

    // Check version compatibility if required
    let version_compatible = if let Some(ref req_version) = require_version {
        let compatible = check_version_compatibility(req_version);
        if !compatible {
            let current_version = env!("CARGO_PKG_VERSION");
            eprintln!(
                "⚠️  world-nav version mismatch: installed v{current_version}, required {req_version}"
            );
            eprintln!("⚠️  Run '{BUILD_SCRIPT_PATH}' to update");
        }
        compatible
    } else {
        true // No version requirement means always compatible
    };

    // Exit with failure if version check fails
    if !version_compatible {
        return Err(io::Error::new(
            io::ErrorKind::Other,
            "Version compatibility check failed",
        ));
    }

    let shell_code = generate_shell_code(args)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

    io::stdout().write_all(shell_code.as_bytes())?;
    Ok(())
}
