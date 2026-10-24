# Security Policy

## Reporting a vulnerability

Please do not open a public issue for security problems.

Use GitHub's private reporting: **Security → Report a vulnerability** on this repository
(https://github.com/CaffeinatedSoftwareLLC/agora/security/advisories/new).

Include what you found, how to reproduce it, and what an attacker could do with it.
You should hear back within a week. Fixes are released on `main`, and the advisory
is published once a fix is out.

## Scope

- Everything in this repository: the API (`src/`), the UI (`agora-ui/`), the MCP server
  (`agora-mcp/`), the sandbox runner and the Docker setup.
- The security model is described in `docs/storage-and-encryption.md` and
  `docs/planning/sandbox-isolation-spec.md`; a report that shows one of those guarantees failing is
  always in scope.

## Out of scope

- Issues in third-party instances you do not operate.
- Denial of service against someone else's instance.
- Reports from automated scanners with no demonstrated impact.
