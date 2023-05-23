<p align="center">
  <a href="https://kinde.com" target="_blank" rel="noopener noreferrer">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="kinde_logo_dark.jpg">
      <img src="../kinde_logo_light.jpg" height="100">
    </picture>
  </a>
</p>

# Contributing <!-- omit from toc -->

## Table of contents <!-- omit from toc -->

- [Introduction](#introduction)
- [TL;DR](#tldr)
- [Code of conduct](#code-of-conduct)
- [Getting started](#getting-started)
  - [Where to look](#where-to-look)
  - [Check first](#check-first)
  - [First time](#first-time)
- [Issues](#issues)
  - [Creating an issue](#creating-an-issue)
  - [Guidelines](#guidelines)
- [Pull requests](#pull-requests)
  - [Creating a PR](#creating-a-pr)
  - [Guidelines](#guidelines-1)
  - [Your PR merges!](#your-pr-merges)
- [New repositories](#new-repositories)
  - [READMEs](#readmes)
  - [Community health files](#community-health-files)
  - [SDK repository name](#sdk-repository-name)
- [SDKs](#sdks)
  - [Mustache templates](#mustache-templates)
    - [TypeScript example](#typescript-example)
- [Documentation](#documentation)
- [Security](#security)
- [Publishing](#publishing)
- [License](#license)
- [Community](#community)
  - [Where to post](#where-to-post)

## Introduction

Thanks for contributing to one of Kinde’s open source (OS) projects. With your help, contributors like you take Kinde OS projects to the next level 👏🏻.

Please take a moment to read over this document to make the contribution process easy and effective for everyone involved 👍🏾.

## TL;DR

- Want to report a bug? Create an [issue](#issues) via the “Bug report” template.
- Want to contribute a new feature or any significant change? Please discuss it in the [Kinde community](#community) first, or create an [issue](#issues) via the “Feature request” template.
- Have a general or a support-type related question? Please head to the [Kinde community](#community) and ask there.
- Have you discovered a security vulnerability? Please refer to the [Kinde vulnerability disclosure policy](https://kinde.com/docs/important-information/vulnerability-disclosure-policy/).
- Want to contribute code to one of Kinde’s SDKs? Please refer to the [SDKs](#sdks) section.

## Code of conduct

Kinde takes its OS community seriously and holds both itself and other contributors to high standards of communication. Kinde’s goal is to foster a positive environment for contributors and to welcome newcomers.

Please review the [code of conduct](CODE_OF_CONDUCT.md) before engaging in Kinde’s OS projects.

## Getting started

There are many ways to get involved, including [improving the documentation](#documentation), [submitting bug reports](#issues) and [feature requests](#issues), and, of course, [writing code](#pull-requests).

Most contributions begin with an [issue](#issues). Once you’re ready to contribute code, a [pull request](#pull-requests) (PR) is required. However, before contributing, please [check first](#check-first).

To contribute **code**, you will need a public GitHub account. If you don’t have one, you can join [here](https://github.com/join).

### Where to look

All Kinde OS projects get hosted on [GitHub](https://github.com/) under the following organizations:

- **[kinde-oss](https://github.com/kinde-oss)**: A bunch of **SDKs and libraries** to work with the Kinde ecosystem.
- **[kinde-starter-kits](https://github.com/kinde-starter-kits)**: A bunch of **starter kits** to work with the Kinde ecosystem.

Each organization has one code repository per project, except for most SDK repositories where two can exist. For more information, refer to the [SDKs](#sdks) section.

### Check first

To save time and prevent duplicating work, it’s best to search the relevant project (repository) for open/closed issues or PRs related to your contribution. This is especially important for significant changes or enhancements.

**You might also check in the [Kinde community](#community) to see if an issue has a discussion history.**

### First time

If it’s your first time contributing to an OS project and you’re feeling a little unsure how to go about it, check out these resources:

- 🎬 Video course on [egghead](https://egghead.io/): [**How to Contribute to an Open Source Project on GitHub**](https://egghead.io/courses/how-to-contribute-to-an-open-source-project-on-github)
- 📄 One of the [Open Source Guides](https://opensource.guide/): [**How to Contribute to Open Source**](https://opensource.guide/how-to-contribute/)

Or, if it’s more Kinde-specific, jump on the [Kinde community](#community) and start a chat with one of the friendly Kinde staff.

🎓 You can read more about getting started with Github in [GitHub Docs](https://docs.github.com/en) → [Get started](https://docs.github.com/en/get-started).

## Issues

Issues is where everything gets logged against a project, including:

- Feature requests
- Bug reports
- Documentation issues

Issues should be the first port of call alongside the [Kinde community](#community) when considering contributing to a Kinde OS project.

🎓 You can read more about issues in [GitHub Docs](https://docs.github.com/en) → [GitHub Issues](https://docs.github.com/en/issues).

### Creating an issue

Before you create a new issue, please [check first](#check-first).

Kinde provides templates per issue type, such as “Feature requests”, which get presented to you when creating a new issue.

These templates help you create your issue in a clear and specific way, saving everybody time.

Please assign the most relevant [label](https://docs.github.com/en/issues/using-labels-and-milestones-to-track-work/managing-labels) to your issue.

🎓 You can read more about creating issues in [GitHub Docs](https://docs.github.com/en) → [Creating an issue](https://docs.github.com/en/issues).

### Guidelines

Please follow these guidelines to ensure that everyone gets the most from your contributions.

- Strive for clear and concise writing to minimize the need for excessive communication. This also applies to comments on issues.
- Keep issue comments focused on the topic at hand.
- Don’t use issues for general or support-type related questions. Head over to the [Kinde community](#community) for help instead.
- Don’t use issues to report security vulnerabilities. Refer to the [Kinde vulnerability disclosure policy](https://kinde.com/docs/important-information/vulnerability-disclosure-policy/).
- We’d prefer if you don’t post issue comments consisting solely of “+1” or “👍”. Use [GitHub’s ‘reactions’ feature](https://github.com/blog/2119-add-reactions-to-pull-requests-issues-and-comments) instead.
- Format your prose and code so it’s clear and useable. See GitHub’s [Basic writing and formatting syntax](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax) doc, also the [Creating and highlighting code blocks](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-and-highlighting-code-blocks) doc. Further mentions:
  - Link to an existing line or range of lines of code in your prose via GitHub’s [Creating a permanent link to a code snippet](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-a-permanent-link-to-a-code-snippet) feature.
  - “@-mention” people where applicable via GitHub’s [Mentioning people and teams](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#mentioning-people-and-teams) feature.
  - Reference existing issues and PRs via GitHub’s [Referencing issues and pull requests](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#referencing-issues-and-pull-requests) feature.

## Pull requests

To make a change to a Kinde OS project, you’ll need to submit a pull request (PR).

All PRs are welcome, from trivial fixes like correcting typos to more substantial changes like introducing new functionality.

**Note:** When contributing to a Kinde SDK project, please ensure you are contributing to the correct repository. Refer to the [SDKs](#sdks) section for more information.

🎓 You can read more about PRs in [GitHub Docs](https://docs.github.com/en) → [Pull requests](https://docs.github.com/en/pull-requests).

### Creating a PR

Before you create a new PR, please [check first](#check-first).

All PRs should be created from a fork. For instructions on how to do this, refer to GitHub’s [Creating a pull request from a fork](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/creating-a-pull-request-from-a-fork) doc.

Please assign the most relevant [label](https://docs.github.com/en/issues/using-labels-and-milestones-to-track-work/managing-labels) to your PR.

The core team is monitoring PRs. They will review your PR and either merge it, request changes, or close it with an explanation. The core team strives to review PRs promptly.

### Guidelines

Please follow these guidelines to create tidy PRs.

- Keep your PR focused in scope - it should address a single concern using the fewest changed lines possible.
- Ensure your PR does not contain any unrelated commits. For related commits, please provide clear log messages.
- Help reviewers understand the changes in your PR by providing a clear and concise description. If there’s an accompanying issue, link to it via GitHub’s [Referencing issues and pull requests](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#referencing-issues-and-pull-requests) feature (you can omit an explanation if the issue has enough detail for a reviewer to understand your changes fully).
- Add tests for fixed or changed functionality if a test suite exists.
- Follow the code style guide if one. Projects may use tools like [Prettier](https://prettier.io/) to apply a style guide automatically. Most projects also have “lint” tasks, such as `npm run lint` for npm libraries. If there is a lint task, please run it before submitting your PR.
- As you update your PR and apply changes, mark each conversation as resolved via GitHub’s [Resolving conversations](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/commenting-on-a-pull-request#resolving-conversations) feature.

### Your PR merges!

Awesome! Thanks so much for contributing to a Kinde OS project.

Once your PR merges, your contributions are publicly visible in the relevant project and will be reflected in the project’s changelog.

## New repositories

Please always create new repositories from the relevant template to ensure consistency across Kinde repositories.

When you create a new repository, GitHub will provide a list of available templates. For example, when you create a new [SDK](#sdks) repository, choose the `kinde-oss-repo-template` template. Once the new repository gets created, complete the checklist in the `_NEW_REPO_CHECKLIST_.md` file.

### READMEs

Please follow the README template to avoid duplicating documentation between the [Kinde docs](https://kinde.com/docs/) and a project’s README and to keep Kinde READMEs consistent.

### Community health files

Please refrain from adding [community health files](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file), e.g. `CONTRIBUTING.md`, `SECURITY.md`, etc. (any of the files listed [here](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file#supported-file-types)) to the repository’s `.github` folder (or in the root or `docs` folder) as Kinde houses these globally in the GitHub organization `.github` repository to avoid duplication and ease of maintenance. If a community health file gets added to a repository, it will override the global health files, which we want to avoid.

### SDK repository name

For the name of an SDK repository, please use the following format: `kinde-[technology/framework name]`, e.g. `kinde-react` or `kinde-elixir`. For generator repositories (see [SDKs](#sdkds) to learn more), add “generator” at the end, e.g. `kinde-react-generator` or `kinde-elixir-generator`.

## SDKs

Most of Kinde’s OS projects are comprised of software development kits (SDKs) that are generated using the [OpenAPI Generator tool](https://openapi-generator.tech/). As a result, each SDK has two repositories: one for the generator and one for the end code. For example, the Ruby SDK has the following repositories:

- **Generator:** [kinde-ruby-generator](https://github.com/kinde-oss/kinde-ruby-generator)
- **End code:** [kinde-ruby-sdk](https://github.com/kinde-oss/kinde-ruby-sdk)

In most cases, contributions should be made against the generator repository since it creates the end code repository. However, there are cases where it makes sense to make changes to the end code repository, such as for test code that validates the overall use of the SDK.

### Mustache templates

In certain circumstances, it may be necessary to modify the [Mustache](https://mustache.github.io/) templates used by the OpenAPI generator tool. One common reason for this is when you need to reference a user-written module from a generated code module.

#### TypeScript example

Taking the [TypeScript generator](https://github.com/kinde-oss/kinde-typescript-generator) as an example, an additional line must get added to the generated `index.ts` code file to reference the user-written modules in the [`client.ts` file](https://github.com/kinde-oss/kinde-typescript-generator/blob/3bd05bd91bccf17feb7b75f1e55f7a7b95e9ada5/additional/client.ts). In this case, the [`index.mustache` template file](https://github.com/kinde-oss/kinde-typescript-generator/blob/3bd05bd91bccf17feb7b75f1e55f7a7b95e9ada5/templates/index.mustache) must get edited to refer to the `client.ts` code.

```ts
/* tslint:disable */
/* eslint-disable */
export * from './runtime';
{{#useSagaAndRecords}}
export * from './runtimeSagasAndRecords';
export * from './ApiEntitiesRecord';
export * from './ApiEntitiesReducer';
export * from './ApiEntitiesSelectors';
{{/useSagaAndRecords}}
{{#apiInfo}}
{{#apis.0}}
export * from './apis';
{{/apis.0}}
{{/apiInfo}}
{{#models.0}}
export * from './models';
{{/models.0}}
export * from './client/client'; /* This line was added */
```

↑ _An example of modifying a Mustache template in the TypeScript generator ([reference file](https://github.com/kinde-oss/kinde-typescript-generator/blob/3bd05bd91bccf17feb7b75f1e55f7a7b95e9ada5/templates/index.mustache))._

## Documentation

To avoid duplicating documentation between the [Kinde docs](https://kinde.com/docs/) and a project’s README, Kinde prefers to link to the Kinde docs when possible.

If you encounter problems with the [Kinde docs](https://kinde.com/docs/), believe something is missing or unclear, or spot a typo, please submit an [issue](#issues) via the “Documentation issues” template.

If a project does not have an accompanying Kinde doc and there are issues in the README, please feel free to raise them in an [issue](#issues). For trivial changes, such as correcting a typo, go ahead and fix it via a [PR](#pull-requests).

## Security

If you discover a security vulnerability in a Kinde OS project, please report it through the [Kinde vulnerability disclosure policy](https://kinde.com/docs/important-information/vulnerability-disclosure-policy/). Kinde’s security team closely monitors this policy to ensure that any reported vulnerabilities get promptly and appropriately addressed. For more information, please visit [Security at Kinde](https://kinde.com/docs/important-information/security-at-kinde/).

## Publishing

The core team is in charge of handling version updates and publishing. We’re currently working on updating the documentation for this, and it should be available soon.

Kinde OS projects adhere to the [Semantic Versioning standard](https://semver.org/), and we strive to ensure that changelogs are available for each project.

## License

By contributing to Kinde, you agree that your contributions will be licensed under its MIT License.

## Community

Join us in the Slack [Kinde community](https://thekindecommunity.slack.com) and post your questions there. The whole Kinde team is on hand to help you out.

**Note:** Please submit your general or support-related questions in the Kinde community rather than on GitHub.

### Where to post

| Slack channel | For |
| --- | --- |
| [#requests-and-feedback](https://thekindecommunity.slack.com/archives/C04K34HUV9B) | Feature requests + product feedback |
| [#questions](https://thekindecommunity.slack.com/archives/C04KVMGSZLG) | General questions |
| [#kinde-support](https://thekindecommunity.slack.com/archives/C04K316BXEH) | Support questions and reporting bugs |
| [#documentation](https://thekindecommunity.slack.com/archives/C057M2BQ6LV) | Reporting documentation issues |
