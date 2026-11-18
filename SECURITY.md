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

## What the agent gate guarantees

What FormPDF promises:

- Only the FormPDF window can change agent access (Ask, Allowed, Blocked), change
  which Claude program the agent dock runs, use the agent dock (terminals, Claude
  Code, Chat), turn on a plug-in, change signing identities or trusted
  certificates, or answer "Allow agents to edit?". The same holds for every other
  change made through the engine's window routes: opening, editing and saving PDFs,
  batch jobs, scans, window commands and the assistant. Each launch of the engine
  makes a new key that only the window holds; a change requested without it is
  refused. Outside agents use the MCP server instead, where consent applies.
- Outside agents (MCP clients, `./formpdf run`, `./formpdf cli`) follow the
  person's choice. Under Ask, a change with no window open is refused. None of them
  can change the choice.
- The key Claude Code uses inside the agent dock belongs to that one tab, is never
  on a command line or in a plain terminal, and stops working when the tab closes.
- The choice is sealed with a key kept in the system keychain. If settings.json is
  changed by hand to loosen it, FormPDF acts as Ask until the person sets it again
  in the window. Without a usable keychain the seal is skipped and the stored
  choice stands; FormPDF still starts.

What it does not promise:

- It does not protect your files from other programs. Any program running as your
  user can read and change the files you can, including PDFs and FormPDF's data
  folder, without going through FormPDF.
- Running from source is weaker than the installed app. The installed app hands
  the window its key privately; from source the engine gives the key to the first
  program that asks for it, which is normally the window you open with
  `./formpdf`.
