# Contributing to ClawPad

Thank you for your interest in contributing to ClawPad, an autonomous token launch platform powered by OpenClaw AI!

## How to Contribute
1. Fork the repository and create a new branch: `git checkout -b feature/my-new-feature`.
2. Make your changes (e.g., add a new venue SDK in src/, fix a bug in vanity-pool.mjs).
3. Test locally: Run `npm install`, set up .env, then `node server.mjs`.
4. Commit with descriptive messages: `git commit -m "feat: add support for new chain XYZ"`.
5. Push to your fork and open a Pull Request, describing the changes and why they're useful.

## Code Style Guidelines
- Use ES Modules (.mjs) for all JavaScript files.
- Follow the existing structure: `src/` for core logic (e.g., clanker.mjs, erc8004.mjs), `skills/` for AI prompts and agents.
- Avoid hard-coded secrets; use environment variables.
- Keep code deterministic and non-custodial where possible.

## Reporting Issues
- Use GitHub Issues for bugs, feature requests, or questions.
- Label appropriately (e.g., `bug`, `enhancement`, `documentation`).

For questions, reach out on X (@clawpad) or email contact@clawp.ad.
