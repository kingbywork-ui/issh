"""Live source-tree GUI UAT for the optional Herdr pane bridge.

The caller owns the temporary Herdr session and pane. This script only launches
an isolated issh profile, opens the pane through the real Workspace UI, sends a
marker through xterm, and confirms that opening the same pane is idempotent.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from smoke_helpers import SmokeApp, write_isolated_config  # noqa: E402


def required_path(name: str) -> Path:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Set {name} to run the live Herdr pane GUI UAT")
    path = Path(value).resolve()
    if not path.is_file():
        raise FileNotFoundError(f"{name} does not point to a file: {path}")
    return path


def required_value(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Set {name} to run the live Herdr pane GUI UAT")
    return value


def main() -> int:
    binary = required_path("HERDR_BIN")
    session = required_value("HERDR_SESSION")
    workspace_id = required_value("HERDR_WORKSPACE_ID")
    target = required_value("HERDR_TARGET")
    marker = "ISSH_PHASE8_GUI_UAT"

    def write_config(config_dir: Path) -> None:
        write_isolated_config(config_dir)
        config_path = config_dir / "config.yaml"
        config_text = config_path.read_text(encoding="utf-8").replace(
            "terminal:\n  autoOpen: false",
            "terminal:\n  autoOpen: false\n  frontend: xterm",
        )
        config_path.write_text(config_text, encoding="utf-8")
        binary_yaml = str(binary).replace("'", "''")
        session_yaml = session.replace("'", "''")
        with config_path.open("a", encoding="utf-8") as config:
            config.write("  herdrEnabled: true\n")
            config.write("  herdrAutoStart: false\n")
            config.write(f"  herdrBinaryPath: '{binary_yaml}'\n")
            config.write(f"  herdrSession: '{session_yaml}'\n")

    app: SmokeApp | None = None
    try:
        app = SmokeApp.launch(
            config_writer=write_config,
            temp_prefix="issh-herdr-pane-gui-uat-",
            launch_log_path=ROOT / "herdr_pane_gui_uat.log",
        )
        page = app.page
        page.evaluate(
            """() => {
                window.__isshHerdrPaneEvents = []
                window.require('electron').ipcRenderer.on('herdr:pane-event', (_event, paneEvent) => {
                    window.__isshHerdrPaneEvents.push(paneEvent)
                })
            }"""
        )
        page.keyboard.press("Control+,")
        page.locator("settings-tab").wait_for(state="visible", timeout=20_000)
        page.locator("settings-tab a", has_text="Agent Workspace").click()
        panel = page.locator("workspace-settings-tab")
        panel.wait_for(state="visible", timeout=20_000)
        runtime_ready = False
        last_error: Exception | None = None
        runtime_section = panel.locator(".llm-section").nth(0)
        for _ in range(3):
            try:
                runtime_section.get_by_text("PID", exact=False).wait_for(
                    state="visible", timeout=8_000
                )
                runtime_ready = True
                break
            except Exception as error:
                last_error = error
                runtime_section.locator("button").click()
        if not runtime_ready:
            raise RuntimeError(
                f"Workspace UI did not connect to Runtime. Config: {app.config_dir}\n"
                "Visible panel text:\n"
                + panel.inner_text()
            ) from last_error

        workspace_name = "Phase 8 GUI UAT"
        workspace_section = panel.locator(".llm-section").nth(2)
        workspace_input = workspace_section.locator("input.form-control")
        workspace_input.fill(workspace_name)
        workspace_section.locator("button.btn-primary").click()
        workspace_select = workspace_section.locator("select.form-control")
        workspace_select.wait_for(state="attached", timeout=20_000)
        if not workspace_select.input_value():
            raise AssertionError("Workspace creation did not select the new workspace")

        herdr_section = panel.locator(".llm-section").nth(1)
        workspace_select = herdr_section.locator("select.form-control")
        workspace_select.wait_for(state="visible", timeout=20_000)
        workspace_select.select_option(workspace_id)
        herdr_section.locator(".input-group button").first.click()

        pane_row = herdr_section.locator(".border.rounded").filter(has_text=target)
        pane_row.wait_for(state="visible", timeout=20_000)
        pane_row.locator("button.btn-outline-primary").click()
        terminal = page.locator("herdr-pane-tab")
        terminal.wait_for(state="visible", timeout=20_000)
        terminal.locator(".xterm-screen").wait_for(state="visible", timeout=20_000)
        terminal.locator(".xterm-screen").click()
        textarea = terminal.locator(".xterm-helper-textarea")
        textarea.focus()
        textarea.press_sequentially(f"echo {marker}", delay=10)
        textarea.press("Enter")

        environment = os.environ.copy()
        environment["HERDR_SESSION"] = session
        completed = subprocess.run(
            [
                str(binary),
                "--session",
                session,
                "pane",
                "wait-output",
                target,
                "--match",
                marker,
                "--timeout",
                "20000",
                "--raw",
            ],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError(
                "Herdr did not observe the xterm marker: "
                + (completed.stderr.strip() or completed.stdout.strip())
            )
        pane_events = page.evaluate("() => window.__isshHerdrPaneEvents")
        event_output = bytes(
            byte
            for event in pane_events
            if event.get("type") == "output"
            for byte in event.get("data", [])
        ).decode("utf-8", errors="replace")
        if marker not in event_output:
            raise AssertionError(
                f"Electron did not deliver marker output events; events={len(pane_events)}"
            )

        page.keyboard.press("Control+,")
        page.locator("settings-tab a", has_text="Agent Workspace").click()
        panel = page.locator("workspace-settings-tab")
        herdr_section = panel.locator(".llm-section").nth(1)
        pane_row = herdr_section.locator(".border.rounded").filter(has_text=target)
        pane_row.wait_for(state="visible", timeout=20_000)
        pane_row.locator("button.btn-outline-primary").click()
        if page.locator("herdr-pane-tab").count() != 1:
            raise AssertionError("opening the same Herdr pane created a duplicate tab")

        print(
            f"Herdr pane GUI UAT passed: session={session} "
            f"workspace={workspace_id} target={target} marker={marker}"
        )
        return 0
    finally:
        if app is not None:
            app.close()


if __name__ == "__main__":
    raise SystemExit(main())
