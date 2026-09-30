# Project Working Agreement

## Requirements Baseline

Read `docs/PROJECT-REQUIREMENTS.md` before substantive work in this repository.
It is the canonical project requirements and security-boundary specification.
Use its requirement IDs when planning, implementing, reviewing, and testing a change.
Read the applicable sections and linked domain contracts, not every historical file.

- Distinguish required behavior from current implementation and verified production state.
- Check section 12 for known gaps. Do not describe an open gap as implemented or accepted.
- Do not use existing code or tests to override the requirements. A test that endorses
  predictable-ID public access is a defect, not a compatibility contract.
- Public display IDs are not access credentials. Preserve SEC-001 through SEC-010
  across record reads, sharing, media, QR images, H5, and the miniapp.
- Propose material requirement changes and their impact to the user first. Record
  approved changes in the baseline and update affected tests and domain documents.
- Product configuration within approved limits does not require rewriting the baseline.
- `CODEX_PROJECT_MEMORY.md` and older plans remain historical context. Preserve user
  changes; do not restore obsolete positioning, promises, example URLs, or deployment states.
- Maintain this specification in the repository. Knowledge-base notes should link to it,
  not become a separately maintained authoritative copy.

Documentation is not evidence of implementation, deployment, backup coverage, or
security acceptance. Authorization for a document or local fix does not authorize
pushes, production changes, migrations, external charges, or token rotation.

The parent workspace safety, production-command-delivery, and RC-MCDI instructions
continue to apply. This file does not override higher-priority or security requirements.
