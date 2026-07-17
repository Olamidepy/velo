# Changelog

All notable changes to Velo will be documented in this file.

## Unreleased

### Added

- `atomic-swap` contract now fully implements the `htlc-core::Htlc` trait
  (lock/release/refund); `release()` reveals the secret in an event for the
  cross-chain relayer, with a full Rust test suite (#12),
- `apps/relayer`: off-chain relayer that watches Soroban `released` events and
  claims the counterpart HTLC on an EVM chain, with unit tests and a demo
  walkthrough (#12),
- `contracts-evm/HTLC.sol`: SHA-256-hashlocked EVM counterpart HTLC (#12),
- proposed persistence schema + migration for cash requests, Bazaar intents,
  and reputation (#24),
- relayer architecture comparison (custom vs LayerZero/Wormhole/Axelar) with a
  recommendation (#25),
- expanded contributor-facing documentation,
- production-oriented repository overview and architecture guidance,
- security, conduct, and governance policies.

### Changed

- rewrote the main README to better explain the project’s purpose and structure.
