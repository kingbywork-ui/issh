use std::process::Stdio;
use tokio::process::Command;

// Fixed executable lookup only: never run an agent or write to the interactive PTY.
const POSIX_PROBE: &str = r#"for name in pi omp codex claude opencode hermes hermes-agent; do
path="$(command -v "$name" 2>/dev/null)"
if [ ! -f "$path" ] || [ ! -x "$path" ]; then
path=""
for dir in "$HOME/.local/bin" "$HOME/.npm-global/bin" "$HOME/.npm/bin" "$HOME/.bun/bin" "$HOME/.cargo/bin" "$HOME/.opencode/bin" "$HOME/.hermes/venv/bin" "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin "$HOME/.local/share/fnm/node-versions"/*/installation/bin "$HOME/.volta/bin" "$HOME/.local/share/pi-node"/*/bin; do
if [ -f "$dir/$name" ] && [ -x "$dir/$name" ]; then path="$dir/$name"; break; fi
done
fi
if [ -n "$path" ]; then printf '%s\t%s\n' "$name" "$path"; fi
done"#;

fn command(shell: Option<&str>) -> Command {
    #[cfg(windows)]
    {
        let mut cmd = match shell {
            Some("wsl") => {
                let mut cmd = Command::new("wsl.exe");
                cmd.args(["--exec", "sh", "-lc", POSIX_PROBE]);
                cmd
            }
            Some("git-bash") => {
                let executable = [
                    "C:\\Program Files\\Git\\bin\\bash.exe",
                    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
                ]
                .into_iter()
                .find(|path| std::path::Path::new(path).is_file())
                .unwrap_or("bash.exe");
                let mut cmd = Command::new(executable);
                cmd.args(["-lc", POSIX_PROBE]);
                cmd
            }
            _ => {
                let mut cmd = Command::new(if shell == Some("pwsh") {
                    "pwsh.exe"
                } else {
                    "powershell.exe"
                });
                cmd.args(["-NoProfile", "-NonInteractive", "-Command", r#"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); foreach ($name in @('pi','omp','codex','claude','opencode','hermes','hermes-agent')) { $item = Get-Command $name -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1; if ($item) { [Console]::WriteLine($name + "`t" + $item.Source) } }; exit 0"#]);
                cmd
            }
        };
        cmd.creation_flags(0x08000000);
        cmd
    }
    #[cfg(not(windows))]
    {
        let _ = shell;
        let mut cmd = Command::new("sh");
        cmd.args(["-lc", POSIX_PROBE]);
        cmd
    }
}

pub async fn probe(shell: Option<&str>) -> Result<String, String> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        command(shell)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "Local agent probe timed out".to_string())?
    .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Local agent probe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    if output.stdout.len() > 16 * 1024 {
        return Err("Local agent probe output exceeds limit".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn wsl_probe_keeps_script_literal_and_separate_from_terminal() {
        let cmd = command(Some("wsl"));
        let args: Vec<_> = cmd.as_std().get_args().collect();
        assert_eq!(cmd.as_std().get_program(), "wsl.exe");
        assert_eq!(args, ["--exec", "sh", "-lc", POSIX_PROBE]);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_probe_succeeds_even_when_some_agents_are_missing() {
        // Get-Command reports an error for absent optional executables; that must
        // not discard successful earlier lookups or turn an empty scan into failure.
        probe(Some("powershell"))
            .await
            .expect("optional agents may be absent");
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "requires Windows Pi installed"]
    async fn live_windows_pi_probe() {
        let output = probe(Some("powershell")).await.unwrap();
        assert!(
            output.lines().any(|line| line.starts_with("pi\t")),
            "{output}"
        );
    }

    #[tokio::test]
    #[ignore = "requires local WSL with Pi installed"]
    async fn live_wsl_pi_probe() {
        let output = probe(Some("wsl")).await.unwrap();
        assert!(
            output.lines().any(|line| line.starts_with("pi\t/")),
            "{output}"
        );
    }
}
