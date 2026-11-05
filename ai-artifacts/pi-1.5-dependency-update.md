# Pi 1.5 dependency update

[Dependabot run 41224910972](https://github.com/iurysza/pi-voice/actions/runs/41224910972) failed with `security_update_not_possible`. Pi coding-agent 1.4.0 requires Undici 8.10.2 exactly, while the reported alerts require at least 8.12.2. A lockfile refresh alone cannot escape that parent pin. Registry requests succeeded; this failure does not justify changing Dependabot YAML, authentication, or permissions.

The three Pi development pins and three peer pins now use 1.5.0. Pi coding-agent 1.5.0 requires Undici 8.12.3. The regenerated root lockfile contains only `node_modules/undici` at 8.12.3. No overrides, resolutions, or non-Pi direct pins changed.

Non-fake startup checks the running Pi version against `src/domain.ts`'s `PI_VERSION`. That constant was stale at 0.85.1 and is now 1.5.0, matching the package pins and README. Exact equality and host-version discovery are unchanged. The host-layout test's 0.85.1 remains an arbitrary lookup fixture, not a supported-version claim.

## Verification

- `test/dependency-contract.test.ts` checks independent 1.5.0 expectations for the runtime constant, development pins, peer pins, installed packages, and lock entries. It checks Pi's exact Undici requirement and the sole 8.12.3 lock entry, rejecting vulnerable nested copies too.
- `test/extension.test.ts` exercises the non-fake startup guard with injected versions, fake media, and an injected socket. Pi 1.5.0 reaches listening and closes cleanly. Pi 1.4.0 is rejected before socket creation. Neither test uses a microphone, network, or real API credentials.
- Pi 1.5 adds required `keyText` and `keyHint` renderer options. A typed renderer-test fixture supplies those callbacks; production rendering and existing assertions are unchanged.
- `npm ci --ignore-scripts --no-audit --no-fund`: exit 0.
- `npm run quality`: exit 0, including lint, typecheck, build, all 93 tests, and package dry-run.
- `npm audit --json`: exit 0, zero vulnerabilities.
- `git diff --check`: exit 0.

Live microphone/Realtime behavior and an installed Pi TUI session were not tested. Updating the local lock does not prove GitHub has closed its alerts; that requires the lead's reviewed change to reach the default branch. Raw diagnosis and verification logs are under `/tmp/oss-pass-pi-voice/`.
