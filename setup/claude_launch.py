import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NOTE = ("You are Claude Code connected to formpdf, the PDF editor on this computer, through its MCP server. "
        "Start with get_context; open_pdf shows a file in the window; the pdf tool does the job; render_pages to look; "
        "list_commands and run_command reach anything in the window's menus.")


def lookup():
    import importlib.util

    spec = importlib.util.spec_from_file_location("formpdf_agent_lookup", ROOT / "backend" / "app" / "services" / "agent_lookup.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def main(argv: list[str]) -> int:
    finder = lookup()
    found = finder.find("claude", override_vars=("FORMPDF_CLAUDE_BIN",))
    claude = found.path
    if not claude:
        print("[formpdf] " + finder.sentence(found, finder.install("claude")), file=sys.stderr)
        return 1
    launcher = str(ROOT / ("formpdf.bat" if os.name == "nt" else "formpdf"))
    config = {"mcpServers": {"formpdf": {"type": "stdio", "command": launcher, "args": ["mcp"]}}}
    cmd = [claude, "--mcp-config", json.dumps(config), "--allowedTools", "mcp__formpdf", "--append-system-prompt", NOTE, *argv]
    return subprocess.call(cmd, cwd=os.environ.get("FORMPDF_CALLER_DIR") or os.getcwd())


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
