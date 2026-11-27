# Rules for agents working in this repository

## Every pull request that changes the extension must carry its release

A pull request that changes what ships in the extension MUST, in the same branch:

1. raise `version` in `package.json` (patch for a fix, minor or major for features, since the tag automation only
   auto-raises the patch after the newest `X.Y.Z` tag);
2. add the matching `## <version>` section in `CHANGELOG.md` with user-facing release notes of at most 3000
   characters of plain text (the addons.mozilla.org limit). Sections in the changelog go newest first: a new section
   is inserted right after the introductory paragraphs, before the newest of the versions already there, never under
   an older one.

The unit tests fail while the version of `package.json` has no changelog section, and the failure surfaces only after
the merge, in the *Tag release on merge* workflow, because the pull request CI builds with the version of the base
branch. A merge without the bump and the section breaks the release pipeline.

Merging a pull request into `main` tags and releases it automatically while the repository variable
`RELEASE_ON_MERGE` is true: do not merge a pull request whose changes are not meant to ship yet.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the full release process and the store publishing setup.

## Tests

- `npm test` runs the unit tests; they are required to pass before a pull request is opened.
- `npm run e2e` and `npm run e2e:firefox` run the extension in real browsers against a mock of Coddy.
