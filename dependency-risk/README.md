# dependency-risk

An AI and metadata review of Renovate PRs. It runs as a required check, so Renovate only auto-merges updates that come back **low** risk.

The check doesn't look at the update type. Keeping major and `0.x` updates out of auto-merge is the job of the [`kinde-oss/renovate-config`](https://github.com/kinde-oss/renovate-config) preset, so a repo that doesn't extend it (or set an equivalent rule) can auto-merge a major update that comes back low.

It only understands pnpm lockfiles (format 6.x or 9.x), `package.json` and GitHub Actions `uses:` refs. Any other change in a Renovate PR (npm or yarn lockfiles, Dockerfiles, `go.mod`, `pnpm-workspace.yaml` catalogs, `.nvmrc`, ...) comes back **medium** and needs a human.

## How it decides

1. **`collect-context.mjs`** compares the PR's base and head commits. It doesn't install or run anything.
   - For `pnpm-lock.yaml`, it finds every updated and newly added package (direct and transitive), including a workspace package moving to a version that was already in the lockfile, and pulls from the npm registry:
     - publisher
     - provenance
     - install scripts
     - new dependencies
     - the published code diff (`npm diff`) for updated packages, the first 40 in each lockfile. Only files that run when the package is used count towards the 100,000-character review budget: the new version's tarball decides which those are (entry points, including every file a wildcard or folder `exports` pattern matches, code, and any file the code refers to, with or without the extension Node adds, followed through every file it reaches, including commands in the `scripts` of the root `package.json` and any other one reached; a file a script command names counts even with an image extension). Every other changed file counts too, test folders and unfamiliar data formats included, because code can load any file by a name built at runtime. Only docs, type declarations, source maps, styles, markup and binary assets are listed by name instead. A changed binary file that runs, such as a `.node` addon, can't be shown, so it means not fully reviewed.
     - for newly added packages, the published file list, `package.json`, its declared entry points and every other file that could contain code (up to 20,000 characters), read in memory from the tarball with the same path rules npm uses when extracting (nothing is unpacked or run)
   - It checks that each reviewed version is what the lockfile actually installs: the lockfile's integrity hash must match the npm registry's, and nothing may point at another tarball.
   - For workflow files, it finds changed `uses:` refs and reviews what each action runs, within a 100,000-character budget per action:
     - **Node actions:** `action.yml`, the folder the runtime entry files live in (usually `dist/`), any file the runtime code names (with or without the extension Node adds), following those references through every file they reach, changed or not, up to 400 files read; past that the update needs a human, and every changed JavaScript or script file (`.js`, `.cjs`, `.mjs`, `.node`, `.wasm`, `.sh`, `.ps1`, `.py` and similar) anywhere in the repo (test folders and `.github/` included), since the bundle can reach it through files this review never reads. A `sourceMappingURL` comment doesn't count as loading the source map. GitHub's compare API leaves out the diff for large bundles, so those files are fetched at both refs and diffed here. TypeScript source, TypeScript tests and the repo's workflow YAML don't run, so they're shown only as context when there's room.
     - **Composite actions:** `action.yml` and every file that isn't docs or data, including tests and anything under `.github/` except the workflow YAML itself, since `run:` steps can execute anything in the repo. A doc or data file counts too when a script (`npm run ...`) in the action folder's `package.json`, or any other one reached, names it, or a `run:` step does, even with an image extension. This applies to Node actions as well, and a change to the action folder's `package.json` is always shown.
     - **Known limit:** an action's data files (JSON, YAML, ...) count only when the code reached from `action.yml` names them, or they sit in the bundle folder. One loaded by a name built at runtime (for example `require(dir + name + '.json')`) isn't reviewed. Requiring every changed data file would put `package-lock.json` and workflow YAML into nearly every action update.
     - **Any action:** if `action.yml` now runs something else (another entry file or action type), the newly selected code may be unchanged and absent from the compare, so the update needs a human.
     - **Docker actions:** the image can't be reviewed, so these always need a human.
   - It also includes the Renovate PR description, which carries the release notes.
2. **Deterministic flags** come from that metadata and set a minimum verdict:
   - install script added or changed → high
   - provenance lost → high
   - new package with install scripts → high
   - lockfile installs something other than the registry artifact that was reviewed (integrity mismatch, or a tarball from anywhere but the npm registry) → high
   - publisher changed → medium
   - a commit on the PR not authored by the bot, or not verified by GitHub → medium
   - unsupported pnpm lockfile format, lockfile deleted, or a lockfile change none of the checks recognise → medium
   - a new lockfile entry that isn't a plain npm registry package (URL, git, file or tarball source) → medium
   - new GitHub Action → medium
   - changed files the check can't analyse → medium
   - `package.json` changed outside its dependency fields (`packageManager`, `engines`, `overrides`, `scripts`, ...) → medium
   - workflow lines changed other than action `uses:` refs (`docker://` images, `run:` steps, ...) → medium
   - lockfile resolution or integrity changed without a version change → medium
   - an update whose code that runs wasn't fully shown to the model → medium. That covers:
     - changed runnable code over the review budget, or binary;
     - past the 40-diff limit;
     - the diff, compare or tarball couldn't be fetched, or failed partway;
     - a new package's code is binary or over 20,000 characters;
     - a tarball has entries the reader can't interpret like npm would;
     - an entry point declared in a `package.json` (or a nested one) is missing;
     - a Docker action.

     Large updates (framework bundles, big rebuilt action bundles) usually land here and need a human; small and patch updates usually don't.
   - a `package.json` dependency spec change that doesn't move that dependency to a new resolved version in its own lockfile importer (including when the entry disappears) → medium
   - a dependency resolved to a non-registry or aliased version (`link:`, `file:`, git, `npm:` alias) → medium
   - an action ref removed with no replacement at the same site (a deleted step), or several refs for one action changed together so they can't be paired → medium
3. **`assess.mjs`** sends the collected data to Claude as untrusted data and gets a structured verdict back.
   - Each updated package, new package and action is a unit that is reviewed whole. Units are packed into calls of up to 150,000 characters (about 37,000 tokens), so a large grouped PR is reviewed in several calls, four at a time, each with the release notes. A big package gets a call to itself; small ones share.
   - Rate limits and server errors are retried twice before a call counts as failed.
   - The final verdict is the **highest** of every call's verdict, the severity of each finding, and the flags.
   - Units past the overall budget of 2,000,000 characters (about 500,000 tokens, roughly $2 of Opus 5.5 input at most) aren't sent, and are flagged medium instead.
   - A unit that had to be cut can't be judged low.
   - Any error (API down, bad output, crash, a failed call) counts as **high**.
4. The workflow posts one sticky PR comment, labels anything that isn't low with `needs-human`, and fails the check.

## Overriding

Review the PR, add the `risk-accepted` label, then use **Re-run jobs** on the failed check. The workflow reads labels live, so the re-run passes and Renovate merges.

The label approves the commits you reviewed, not later ones. When new commits arrive (Renovate updates the branch, or anyone pushes to it), the workflow removes the label before reviewing again, so you'll need to review and accept again.

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
| `require-verified-commits` | `true` | Flag the PR unless every commit is authored by `bot-login` and shows as verified on GitHub. The hosted Renovate app's commits should be verified; set this to `false` if yours aren't (for example, self-hosted Renovate without commit signing). |

## Tests

```bash
node --test 'dependency-risk/test/*.test.mjs'
```

The suite needs Node 22 and git, and no network. It runs on every PR that touches these files (`.github/workflows/dependency-risk-tests.yml`). Every repo using the reusable workflow loads these scripts from `main`, so add a test with any change to the parsing or verdict logic.
