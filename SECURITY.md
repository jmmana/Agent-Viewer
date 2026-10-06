# Security Policy

## Reporting a vulnerability

Please do not open a public GitHub issue for a vulnerability that could expose credentials, authentication material, private data or remote-code-execution risk.

Report the issue privately to the repository owner through GitHub's private security reporting features when available.

Include:

- affected version or commit
- reproduction steps
- expected vs actual behavior
- impact
- suggested mitigation, if known

## Scope

Security-sensitive areas include:

- event ingestion authentication
- REST/SSE exposure
- external runtime adapters
- secret sanitization
- exported session data
- future provider credentials

## Secret handling

Agent Viewer should never require model API keys merely to run the local demo.

Do not commit real provider keys, bearer tokens, passwords or production endpoint secrets to the repository.
