fn get_shell_function(
    shell: &str,
    function_name: &str,
    exe_path: &str,
    args: &str,
    result_command: &str,
) -> String {
    let command = format!("{} {}", exe_path, args);

    match shell {
        "fish" => {
            format!(
                r#"function {}
    set -l paths ({} $argv)
    if test (count $paths) -gt 0
        {} $paths
    end
end"#,
                function_name, command, result_command
            )
        }
        "bash" => {
            format!(
                r#"{} () {{
    local paths
    paths=$({} "$@")
    if [[ -n "$paths" ]]; then
        {} $paths
    fi
}}"#,
                function_name, command, result_command
            )
        }
        "zsh" => {
            format!(
                r#"{} () {{
    local paths
    paths=($({} "$@"))
    if [[ ${{#paths[@]}} -gt 0 ]]; then
        {} ${{paths[@]}}
    fi
}}"#,
                function_name, command, result_command
            )
        }
        _ => String::new(),
    }
}

pub struct ShellCommandConfig {
    pub args: &'static str,
    pub result_command: &'static str,
    pub default_name: &'static str,
}

pub const NAVIGATION_CONFIG: ShellCommandConfig = ShellCommandConfig {
    args: "",
    result_command: "cd",
    default_name: "wl",
};

pub const CODE_CONFIG: ShellCommandConfig = ShellCommandConfig {
    args: "--multi",
    result_command: "code",
    default_name: "jc",
};

pub fn validate_function_name(name: &str) -> Result<(), String> {
    if name
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
    {
        Ok(())
    } else {
        Err(format!(
            "Function name '{}' contains invalid characters. Use only letters, numbers, underscores, and hyphens.",
            name
        ))
    }
}

pub fn get_shell_init(
    shell: &str,
    exe_path: &str,
    function_name: Option<&str>,
    config: &ShellCommandConfig,
) -> Result<String, String> {
    let function_name = function_name.unwrap_or(config.default_name);

    validate_function_name(function_name)?;

    match shell {
        "fish" | "bash" | "zsh" => Ok(get_shell_function(
            shell,
            function_name,
            exe_path,
            config.args,
            config.result_command,
        )),
        _ => Err(format!("Unsupported shell: {}", shell)),
    }
}
