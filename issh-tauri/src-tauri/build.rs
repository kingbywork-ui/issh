use std::process::Command;

fn main() {
    // 嵌入构建分支：环境变量 ISSH_BUILD_BRANCH 优先，否则从 git 取当前分支。
    // 供关于页「检查更新」做跨分支交叉更新拦截（R-057）。
    let branch = std::env::var("ISSH_BUILD_BRANCH")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| current_git_branch())
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=ISSH_BUILD_BRANCH={branch}");

    // 分支切换（.git/HEAD 变化）或环境变量变化时重跑本脚本，保证嵌入值正确。
    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let git_head = std::path::Path::new(&manifest_dir)
            .join("../../.git/HEAD");
        println!("cargo:rerun-if-changed={}", git_head.display());
    }
    println!("cargo:rerun-if-env-changed=ISSH_BUILD_BRANCH");

    tauri_build::build()
}

fn current_git_branch() -> Option<String> {
    let output = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let branch = String::from_utf8(output.stdout).ok()?;
    let branch = branch.trim().to_string();
    if branch.is_empty() || branch == "HEAD" {
        return None;
    }
    Some(branch)
}
