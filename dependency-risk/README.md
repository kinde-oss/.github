# dependency-risk

An AI and metadata review of Renovate PRs. It runs as a required check, so Renovate only auto-merges updates that come back **low** risk.

The check doesn't look at the update type. Keeping major and `0.x` updates out of auto-merge is the job of the [`kinde-oss/renovate-config`](https://github.com/kinde-oss/renovate-config) preset, so a repo that doesn't extend it (or set an equivalent rule) can auto-merge a major update that comes back low.

It only understands pnpm lockfiles, `package.json` and GitHub Actions `uses:` refs. Any other change in a Renovate PR (npm or yarn lockfiles, Dockerfiles, `go.mod`, `pnpm-workspace.yaml` catalogs, `.nvmrc`, ...) comes back **medium** and needs a human.

## How it decides

1. **`collect-context.mjs`** compares the PR's base and head commits. It doesn't install or run anything.
   - For `pnpm-lock.yaml`, it finds every updated and newly added package (direct and transitive) and pulls from the npm registry:
     - publisher
     - provenance
     - install scripts
     - new dependencies
     - the published code diff (`npm diff`) for updated packages, the first 40 in each lockfile
     - for newly added packages, the published file list, `package.json`, its declared entry points and every other file that could contain code (up to 20,000 characters), read in memory from the tarball (nothing is unpacked or run)
   - For workflow files, it finds changed `uses:` refs and fetches the GitHub compare diff.
   - It also includes the Renovate PR description, which carries the release notes.
2. **Deterministic flags** come from that metadata and set a minimum verdict:
   - install script added or changed → high
   - provenance lost → high
   - new package with install scripts → high
   - publisher changed → medium
   - new GitHub Action → medium
   - changed files the check can't analyse → medium
   - `package.json` changed outside its dependency fields (`packageManager`, `engines`, `overrides`, `scripts`, ...) → medium
   - workflow lines changed other than action `uses:` refs (`docker://` images, `run:` steps, ...) → medium
   - lockfile resolution or integrity changed without a version change → medium
   - an update whose published code never reached the model (past the 40-diff limit, the diff, compare or tarball couldn't be fetched or failed partway, or a new package's code is binary or over 20,000 characters) → medium
   - a `package.json` dependency spec change that doesn't change that dependency's resolved version in its own lockfile importer → medium
   - an action ref removed with no replacement at the same site (a deleted step), or several refs for one action changed together so they can't be paired → medium
3. **`assess.mjs`** sends the context to Claude as untrusted data and gets a structured verdict back.
   - The final verdict is the **highest** of the model's verdict, the severity of each of its findings, and the flags.
   - A truncated context can't be judged low.
   - Any error (API down, bad output, crash) counts as **high**.
4. The workflow posts one sticky PR comment, labels anything that isn't low with `needs-human`, and fails the check.

## Overriding

Review the PR, add the `risk-accepted` label, then use **Re-run jobs** on the failed check. The workflow reads labels live, so the re-run passes and Renovate merges.

## Adding to a repo

1. Copy `workflow-templates/dependency-risk.yml` into the repo as `.github/workflows/dependency-risk.yml`. It also appears under **Actions → New workflow** for every repo in the org.
2. Make sure the `ANTHROPIC_API_KEY` org secret is available to the repo.
3. Extend the shared preset in the repo's `renovate.json` (`"extends": ["github>kinde-oss/renovate-config"]`). It is what keeps majors and `0.x` updates from auto-merging.
4. After the first run, add **`dependency-risk / assess`** as a required status check in the branch ruleset.

## Inputs

| Input | Default | Notes |
| --- | --- | --- |
| `bot-login` | `renovate[bot]` | Change this if you self-host Renovate under another account. |
| `model` | `claude-opus-5-5` | Any Claude model ID. A cheaper model also works, since runs are weekly and grouped. |
| `tools-ref` | `main` | Ref of this repo to load the scripts from. Pin it to a tag or SHA for stability. |
