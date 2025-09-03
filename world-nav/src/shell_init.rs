fn get_shell_function(
    shell: &str,
    function_name: &str,
    exe_path: &str,
    args: &str,
    result_command: &str,
) -> String {
    let command = format!("{exe_path} {args}");

    match shell {
        "fish" => {
            format!(
                r#"function {function_name}
    set -l paths ({command} $argv)
    if test (count $paths) -gt 0
        {result_command} $paths
    end
end"#
            )
        }
        "bash" => {
            format!(
                r#"{function_name} () {{
    local paths
    paths=$({command} "$@")
    if [[ -n "$paths" ]]; then
        {result_command} $paths
    fi
}}"#
            )
        }
        "zsh" => {
            format!(
                r#"{function_name} () {{
    local paths
    paths=($({command} "$@"))
    if [[ ${{#paths[@]}} -gt 0 ]]; then
        {result_command} ${{paths[@]}}
    fi
}}"#
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
            "Function name '{name}' contains invalid characters. Use only letters, numbers, underscores, and hyphens."
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
        _ => Err(format!("Unsupported shell: {shell}")),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    #![allow(clippy::expect_used)]
    use super::*;

    #[test]
    fn test_shell_init_commands() {
        // Test fish shell init with frecency enabled (default)
        let exe_path = "/usr/local/bin/world-nav";
        let function_name = "j";

        let output =
            get_shell_init("fish", exe_path, Some(function_name), &NAVIGATION_CONFIG).unwrap();
        assert!(output.contains("function j"));
        assert!(output.contains(exe_path));
        assert!(output.contains("cd"));

        // Test zsh shell init with frecency enabled (default)
        let output =
            get_shell_init("zsh", exe_path, Some(function_name), &NAVIGATION_CONFIG).unwrap();
        assert!(output.contains("j ()"));
        assert!(output.contains(exe_path));
        assert!(output.contains("cd"));
    }

    #[test]
    fn test_validate_function_name() {
        assert!(validate_function_name("valid_name").is_ok());
        assert!(validate_function_name("valid-name").is_ok());
        assert!(validate_function_name("valid123").is_ok());
        assert!(validate_function_name("").is_ok()); // Empty is all alphanumeric

        assert!(validate_function_name("invalid name").is_err());
        assert!(validate_function_name("invalid!name").is_err());
        assert!(validate_function_name("invalid@name").is_err());
    }

    #[test]
    fn test_get_shell_function() {
        let output = get_shell_function("fish", "test_func", "/bin/world-nav", "--list", "cd");
        assert!(output.contains("function test_func"));
        assert!(output.contains("/bin/world-nav --list"));
        assert!(output.contains("cd $paths"));

        let output = get_shell_function("bash", "test_func", "/bin/world-nav", "--list", "cd");
        assert!(output.contains("test_func ()"));
        assert!(output.contains("/bin/world-nav --list"));
        assert!(output.contains("cd $paths"));

        let output = get_shell_function("zsh", "test_func", "/bin/world-nav", "--list", "cd");
        assert!(output.contains("test_func ()"));
        assert!(output.contains("/bin/world-nav --list"));
        assert!(output.contains("cd ${paths[@]}"));
    }

    #[test]
    fn test_unsupported_shell() {
        let result = get_shell_init(
            "powershell",
            "/bin/world-nav",
            Some("j"),
            &NAVIGATION_CONFIG,
        );
        assert!(result.is_err());
        if let Err(err_msg) = result {
            assert!(err_msg.contains("Unsupported shell: powershell"));
        }
    }
}
