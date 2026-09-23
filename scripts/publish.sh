#!/bin/bash

# Script to handle the complete publishing process
# 1. Configures git for GitHub Actions
# 2. Builds packages
# 3. Publishes the package this run is for, and verifies it against the registry

set -e

echo "Starting publish process..."

# Configure git for GitHub Actions
echo "Configuring git..."
git config user.name github-actions
git config user.email github-actions@github.com

# Build packages
echo "Building packages..."
pnpm build:packages

# `nx release` cuts one GitHub release per package and this workflow runs on
# each of them, so publishing every package from every run means N runs racing
# to PUT the same N versions. One wins each version and the rest get a 403 for
# publishing over something that is now already there — which is what happened
# on the 0.1.0-beta.3 release, where two of three runs went red over a set of
# packages that had all published perfectly well.
#
# Scoping each run to the package its own release named is what makes them
# independent. `PACKAGE_NAME` comes from the release tag; absent it (a manual
# dispatch) publish everything, which is the only case where that is wanted.
if [ -n "${PACKAGE_NAME:-}" ]; then
  echo "Publishing ${PACKAGE_NAME}, the package this release is for..."
else
  echo "No release tag in the environment — publishing every package..."
fi

# A package that is not on the registry yet has no version for nx to compare
# against, so `nx release publish` runs an `npm view` that 404s. Nx does tolerate
# that 404 — but by matching the words "not found" in npm's error prose, which is
# exactly the kind of check that breaks the day npm rewords an error. Since we
# can just ask the registry ourselves, tell nx up front that this is a first
# release and let it skip the lookup entirely.
#
# But a first publish is not something this script decides on its own any more.
# Doing it silently is how a package reaches the registry at whatever version a
# release happened to tag it with, without anyone reading the tarball — and the
# `files`/`exports` of a first publish ship permanently. So an absent registry
# version is a REFUSAL here unless the caller said it meant it:
#
#   ALLOW_FIRST_PUBLISH=true  — set by scripts/first-publish.sh, and by the
#                               Publish workflow's `first_release` dispatch
#                               input, which exists for one job: publishing a
#                               version that was tagged but never reached npm.
#
# Only meaningful when this run is scoped to one package; a bare dispatch that
# publishes everything is not a first release of anything.
ALLOW_FIRST_PUBLISH="${ALLOW_FIRST_PUBLISH:-false}"
FIRST_RELEASE_ARGS=()
if [ -n "${PACKAGE_NAME:-}" ] && ! npm view "$PACKAGE_NAME" version >/dev/null 2>&1; then
  if [ "$ALLOW_FIRST_PUBLISH" = "true" ]; then
    echo "${PACKAGE_NAME} is not on the registry yet — publishing it for the first time,"
    echo "because ALLOW_FIRST_PUBLISH=true was set deliberately."
    FIRST_RELEASE_ARGS=(--first-release)
  else
    echo "⏭️  ${PACKAGE_NAME} has never been published — skipping."
    echo
    echo "   A first publish goes through the **First Publish** workflow, which"
    echo "   dry-runs by default and prints the tarball contents. If this release"
    echo "   was tagged but never reached npm, re-dispatch **Publish** with"
    echo "   \`first_release\` checked to publish the tag that already exists."
    echo
    echo "   Nothing was published."
    exit 0
  fi
fi

# npm applies `latest` to whatever it publishes unless `--tag` says otherwise —
# it does not look at the version. Left alone, a 0.1.0-beta.5 becomes the version
# `npm install <pkg>` hands out, which is the opposite of what a beta is for.
# (This is not hypothetical: @effect-server-utils/cqrs, in the repo this
# workspace was modelled on, carries `latest -> 0.1.0-beta.4` for this reason.)
#
# The tag belongs to the version, so it is derived per package rather than
# configured. `--tag` is one value for the whole nx invocation, so the publish
# runs once per package — which is a loop of one on the normal release-triggered
# path, and the only correct shape on a bare dispatch where two packages can sit
# at different prerelease states.
TO_PUBLISH=()
if [ -n "${PACKAGE_NAME:-}" ]; then
  TO_PUBLISH=("$PACKAGE_NAME")
else
  for manifest in packages/*/package.json; do
    [ -f "$manifest" ] || continue
    TO_PUBLISH+=("$(node -p "JSON.parse(require('fs').readFileSync('$manifest','utf8')).name")")
  done
fi

PUBLISH_LOG=$(mktemp)
trap 'rm -f "$PUBLISH_LOG"' EXIT

PUBLISH_EXIT=0
for name in "${TO_PUBLISH[@]}"; do
  directory=""
  for manifest in packages/*/package.json; do
    [ -f "$manifest" ] || continue
    if [ "$(node -p "JSON.parse(require('fs').readFileSync('$manifest','utf8')).name")" = "$name" ]; then
      directory=$(dirname "$manifest")
      break
    fi
  done

  if [ -z "$directory" ]; then
    echo "❌ $name is not a package in this workspace." >&2
    PUBLISH_EXIT=1
    continue
  fi

  version=$(node -p "JSON.parse(require('fs').readFileSync('$directory/package.json','utf8')).version")
  dist_tag=$(node scripts/dist-tag.mjs "$version")
  echo "Publishing $name@$version under dist-tag \"$dist_tag\"..."

  set +e
  npx nx release publish --verbose --projects="$name" --tag "$dist_tag" "${FIRST_RELEASE_ARGS[@]}" 2>&1 | tee -a "$PUBLISH_LOG"
  one_exit=${PIPESTATUS[0]}
  set -e
  [ "$one_exit" -ne 0 ] && PUBLISH_EXIT=$one_exit
done

# The registry is the source of truth for whether this worked, not the exit
# code — because npm cannot tell you which kind of failure you had.
#
# It answers "you cannot publish over 0.1.0-beta.3" and "you have no rights
# here" with the same E403, so no amount of grepping the log separates a
# harmless re-run from a broken token. The previous version of this check tried:
# it tolerated "cannot publish over" unless the log also matched E401/E403/EOTP
# — and npm's already-published error *is* an E403, so the tolerant branch was
# unreachable and every re-run reported failure.
#
# Asking the registry whether the versions we meant to publish are actually
# there answers the question the exit code was only ever standing in for, and
# makes a re-run idempotent for the right reason rather than by pattern-matching
# on prose npm is free to reword.
# The registry is not read-your-writes. A publish returns before the new version
# is readable — measurably so for a brand-new package name, where the first live
# run of this saw "Published to ..." and a 404 from `npm view` 0.4 seconds later
# and reported a successful publish as a failure.
#
# So retry with backoff before believing a miss. The wait is only ever paid when
# a version is genuinely absent, which is the case that is about to fail anyway.
on_registry() {
  local spec="$1" attempt=0 delay=2
  while :; do
    if npm view "$spec" version >/dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 6 ]; then
      return 1
    fi
    echo "     not visible yet, retrying in ${delay}s (attempt ${attempt}/6)..."
    sleep "$delay"
    delay=$((delay * 2))
  done
}

echo
echo "Verifying against the registry..."

MISSING=()
for manifest in packages/*/package.json; do
  [ -f "$manifest" ] || continue
  name=$(node -p "JSON.parse(require('fs').readFileSync('$manifest','utf8')).name")
  version=$(node -p "JSON.parse(require('fs').readFileSync('$manifest','utf8')).version")

  # Only the package this run was responsible for.
  if [ -n "${PACKAGE_NAME:-}" ] && [ "$name" != "$PACKAGE_NAME" ]; then
    continue
  fi

  if on_registry "$name@$version"; then
    echo "  ✅ $name@$version is on the registry"
  else
    echo "  ❌ $name@$version is NOT on the registry"
    MISSING+=("$name@$version")
  fi
done

if [ ${#MISSING[@]} -eq 0 ]; then
  if [ "$PUBLISH_EXIT" -ne 0 ]; then
    echo
    echo "⚠️  nx exited $PUBLISH_EXIT, but every version this run was responsible for"
    echo "   is on the registry — most likely it was already published. Treating as success."
  fi
  echo "✅ Publish process completed successfully!"
  exit 0
fi

echo
echo "❌ Publish failed — these versions did not reach the registry:"
printf '   - %s\n' "${MISSING[@]}"

if grep -qiE "E403|forbidden" "$PUBLISH_LOG" && [ -n "${FIRST_RELEASE_ARGS:-}" ]; then
  echo
  echo "   npm refused a package name that does not exist yet. The usual cause"
  echo "   is the token: a granular access token restricted to selected packages"
  echo "   cannot CREATE one, only publish over names it already lists."
  echo "   Fix: use a token scoped to the whole account/org, or a classic"
  echo "   Automation token, for the first publish of a new package."
fi

if grep -qiE "EOTP|one-time password" "$PUBLISH_LOG"; then
  echo
  echo "   npm rejected the publish because your account requires a one-time"
  echo "   password for write actions. A CI token cannot supply one."
  echo "   Fix: make NPM_TOKEN a classic *Automation* token — it is the token"
  echo "   type that bypasses the 2FA-for-writes requirement."
  echo "   https://www.npmjs.com/settings/~/tokens"
fi

exit "${PUBLISH_EXIT:-1}"
