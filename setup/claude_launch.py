import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NOTE = ("You are Claude Code connected to formpdf, the PDF editor on this computer, through its MCP server. "
        "Start with get_context; open_pdf shows a file in the window; the pdf tool does the job; render_pages to look; "
        "list_commands and run_command reach anything in the window's menus.")


def main(argv: list[str]) -> int:
    claude = os.environ.get("FORMPDF_CLAUDE_BIN") or shutil.which("claude")
    if not claude:
        print("[formpdf] Claude Code is not installed: https://claude.com/claude-code", file=sys.stderr)
        return 1
    launcher = str(ROOT / ("formpdf.bat" if os.name == "nt" else "formpdf"))
    config = {"mcpServers": {"formpdf": {"type": "stdio", "command": launcher, "args": ["mcp"]}}}
    cmd = [claude, "--mcp-config", json.dumps(config), "--allowedTools", "mcp__formpdf", "--append-system-prompt", NOTE, *argv]
    return subprocess.call(cmd, cwd=os.environ.get("FORMPDF_CALLER_DIR") or os.getcwd())


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
