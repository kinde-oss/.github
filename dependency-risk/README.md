# dependency-risk

An AI and metadata review of Renovate PRs. It runs as a required check, so Renovate only auto-merges non-major updates that come back **low** risk.

## How it decides

1. **`collect-context.mjs`** compares the PR's base and head commits. It doesn't install or run anything.
   - For `pnpm-lock.yaml`, it finds every updated and newly added package (direct and transitive) and pulls from the npm registry:
     - publisher
     - provenance
     - install scripts
     - new dependencies
     - the published code diff (`npm diff`)
   - For workflow files, it finds changed `uses:` refs and fetches the GitHub compare diff.
   - It also includes the Renovate PR description, which carries the release notes.
2. **Deterministic flags** come from that metadata and set a minimum verdict:
   - install script added or changed → high
   - provenance lost → high
   - new package with install scripts → high
   - publisher changed → medium
   - new GitHub Action → medium
3. **`assess.mjs`** sends the context to Claude as untrusted data and gets a structured verdict back.
   - The final verdict is the **higher** of the model's verdict and the flags.
   - A truncated context can't be judged low.
   - Any error (API down, bad output, crash) counts as **high**.
4. The workflow posts one sticky PR comment, labels anything that isn't low with `needs-human`, and fails the check.

## Overriding

Review the PR, add the `risk-accepted` label, then use **Re-run jobs** on the failed check. The workflow reads labels live, so the re-run passes and Renovate merges.

## Adding to a repo

1. Copy `workflow-templates/dependency-risk.yml` into the repo as `.github/workflows/dependency-risk.yml`. It also appears under **Actions → New workflow** for every repo in the org.
2. Make sure the `ANTHROPIC_API_KEY` org secret is available to the repo.
3. After the first run, add **`dependency-risk / assess`** as a required status check in the branch ruleset.

## Inputs

| Input | Default | Notes |
| --- | --- | --- |
| `bot-login` | `renovate[bot]` | Change this if you self-host Renovate under another account. |
| `model` | `claude-opus-5-5` | Any Claude model ID. A cheaper model also works, since runs are weekly and grouped. |
| `tools-ref` | `main` | Ref of this repo to load the scripts from. Pin it to a tag or SHA for stability. |
