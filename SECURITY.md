# Security policy

## Supported versions

Security fixes go into the newest release. Please update before reporting, and
check whether the problem is still there.

| Version | Supported |
| --- | --- |
| 0.57.x (latest release) | Yes |
| Anything older | No |

## Reporting a vulnerability

**Do not open a public issue for a security problem.** Use GitHub's private
reporting instead: on the repository's **Security** tab, choose **Report a
vulnerability**. Include what you found, the steps to reproduce it, the version and
platform, and what an attacker could do with it.

You can expect an acknowledgement within a week. We will keep you informed while it
is fixed and credit you in the release notes, unless you would rather not be named.

## What counts

FormPDF runs on your own machine, so the things that matter most are the ways
something outside it could get in:

- **The engine** binds to loopback (127.0.0.1, port 8198), and its MCP server is
  served there at `/mcp`. Anything that makes it reachable from another machine, or
  lets a web page drive it.
- **Agents**: a changing action running with no window open when the person has not
  allowed agents, or getting past that consent in any other way.
- **Opening a PDF**: a crafted PDF, form or attachment that runs code, reads or writes
  files it should not, or reaches the network.
- **Redaction and sanitising**: content that survives Apply under a redaction box, or
  hidden information that survives Remove hidden information.
- **Signatures and passwords**: a signature reported as valid when it is not, or a
  password or permission that can be bypassed in a file FormPDF wrote.
- **Keys** for the assistant's providers, kept in FormPDF's data folder: anything that
  leaks them.
- **Plug-ins**: a plug-in running before the person allowed it.
- **Files**: saving, exporting or extracting in a way that writes outside where it
  should.

Bugs that need someone to already control your machine, or to run a modified build
of FormPDF, are ordinary bugs: please open an issue for those.
