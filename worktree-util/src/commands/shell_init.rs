#![allow(clippy::expect_used)]

use clap::{ArgMatches, Args, Command, ValueEnum};
use handlebars::Handlebars;
use semver::{Version, VersionReq};
use serde_json::json;
use std::env;
use std::io::{self, Write};

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

    /// Required version for compatibility checks (optional)
    #[arg(long)]
    pub require_version: Option<String>,

    /// Enable navigation function initialization
    #[arg(long)]
    pub init_navigate: bool,

    /// Enable code function initialization
    #[arg(long)]
    pub init_code: bool,
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
    let init_navigate = matches.get_flag("init_navigate");
    let init_code = matches.get_flag("init_code");

    let args = ShellInitArgs {
        shell,
        navigate: navigate.to_string(),
        code: code.to_string(),
        require_version,
        init_navigate,
        init_code,
    };

    handle(&args).expect("Shell init should not fail")
}

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
        Err(_) => "worktree-util".to_string(),
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
        "init_navigate": args.init_navigate,
        "init_code": args.init_code,
        "navigate_cmd": args.navigate,
        "code_cmd": args.code,
        "exe_path": get_exe_path()
    });

    let rendered = handlebars.render(template_name, &data)?;
    Ok(rendered)
}

pub fn handle(args: &ShellInitArgs) -> io::Result<()> {
    // Check version compatibility if required
    let version_compatible = if let Some(ref require_version) = args.require_version {
        check_version_compatibility(require_version)
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
