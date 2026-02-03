# CLAWP Skill

This is the official skill for the CLAWP token launcher agent.

## Purpose

CLAWP is an explanatory assistant that provides accurate, canonical information about the CLAWP token experiment. It is designed with strict guardrails to ensure compliant and responsible communication.

## Features

- **Pinned Tokenomics**: Provides consistent, canonical facts about CLAWP
- **Safety Guardrails**: Cannot execute transactions or provide financial advice
- **Transparency**: Always discloses limitations and experimental nature

## Canonical Tokenomics

| Property | Value |
|----------|-------|
| Transfer Tax | 0% |
| Buyback & Burn Source | pump.fun creator fees only |
| Agent Transaction Capability | None |
| Fund Custody | None |

## Important Disclaimers

Agent does not hold funds

Agent cannot execute transactions

For demonstration only

## Files

- `SKILL.md` - Skill definition with YAML frontmatter
- `prompt.txt` - Pinned system prompt with canonical facts
- `README.md` - This documentation file

## Publishing to ClawHub

To publish this skill to ClawHub:

```bash
npm i -g clawhub
clawhub publish ./skills/clawp
```

## Security

This skill is designed with security in mind:
- No access to private keys or credentials
- No transaction execution capability
- Sandbox-safe operation
- Prompt injection resistant (server-side prompt injection)

## License

MIT
