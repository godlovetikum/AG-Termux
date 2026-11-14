# Releasing to npm

The package name is `agt-cli` (the plain name `agt` belongs to another project). The commands are `agt` and `agt-cli`.

## First publish

```
npm login
npm test
npm pack --dry-run        # review the file list
npm publish               # publishConfig already sets public access
```

Then anyone can run `npm install -g agt-cli`.

## Each new version

```
# edit CHANGELOG.md first
npm version minor         # or patch / major: bumps package.json and makes a git tag
git push --follow-tags
```

Then create a GitHub **Release** for that tag. The `publish` workflow runs the tests on Linux, macOS and Windows and publishes.

One-time setup for the workflow: create an npm automation token (npmjs.com, Access Tokens) and save it in the GitHub repository settings as the secret `NPM_TOKEN`. The workflow publishes with provenance, which needs a public repository; for a private one, remove `--provenance` from `.github/workflows/publish.yml`.

## Renaming the GitHub repository

The code does not need it, but the repository can be renamed (Settings, then Rename); GitHub redirects the old address. Afterwards update the three URLs in `package.json` (`repository`, `bugs`, `homepage`) and the install line in `README.md`.
