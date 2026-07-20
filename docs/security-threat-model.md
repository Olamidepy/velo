# Security Threat Model

This document outlines high-level security considerations for the Tributary project.

## Overview

The project includes Soroban contracts, an API server, web/mobile clients, and deployment infrastructure. Each component has distinct threat surfaces; this document summarizes common threats and mitigations.

## Threats

- Unauthorized access to private keys or secrets
- Reentrancy or logic bugs in smart contracts
- API endpoint abuse or privilege escalation
- Supply-chain risks from dependencies
- Client-side data leakage or unsafe storage

## Mitigations

- Use secure key management and hardware-backed signers where possible
- Follow secure smart contract patterns and run audits and fuzzing
- Enforce strong authentication and rate limiting on APIs
- Keep dependencies up-to-date and use lockfiles
- Protect sensitive data on clients and avoid storing secrets in app bundles

## Contact and Reporting

If you find an issue related to this threat model, report it according to the repository’s security policy.
