# Security Policy

BatutaMCP controls a DAW from an AI client, so its security boundaries matter. Please report problems privately.

## Reporting a vulnerability

Use GitHub private vulnerability reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. Please do not open a public issue or pull request for a suspected vulnerability.

Include the affected version, what you did, what you expected and what happened, and a minimal reproduction if you have one. Expect an acknowledgement within a few days.

## Scope

In scope: bypasses of the Remote Script allowlist, the confirmation flow for destructive actions, the edition and gain guards, path validation, the local socket authentication, the installer's file handling, and the supply chain of released packages.

Out of scope: issues that need an attacker who already runs code as your user, and vulnerabilities in Ableton Live itself.

## Supported versions

Only the latest published release receives security fixes.

## Supply chain

Releases are published from GitHub Actions with npm trusted publishing (no long-lived token), carry npm provenance and a build attestation, and ship a CycloneDX SBOM. The server has no runtime dependencies.
