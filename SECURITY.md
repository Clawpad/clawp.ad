# Security Policy for ClawPad

## Supported Versions
ClawPad is in active development. All versions on the `main` branch are supported.

## Reporting a Vulnerability
If you discover a security vulnerability (e.g., in funding detection via vanity-pool.mjs, API endpoints in server.mjs, or blockchain integrations like clanker.mjs):
- Email us at contact@clawp.ad with details.
- Do not disclose publicly until we've had time to review and patch (aim: 48-hour acknowledgment, 7-day fix).
- Provide steps to reproduce, impact, and any suggested fixes.

## Security Features
- Non-custodial funding: No private keys held by the platform.
- Encrypted sensitive data: API keys and claims stored securely in PostgreSQL via db.mjs.
- Deterministic execution: Rule-based, no manual interventions or conditional logic.
- Dependencies: Regularly audited with `npm audit`.

We encourage responsible disclosure and may offer bounties for critical issues (DM @clawpad on X for details).
