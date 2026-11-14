#!/bin/sh
# Signs an Agent Coding.app bundle with a certificate from the keychain, or ad hoc ("-") if
# there is none. Usage: sh build/sign.sh "/path/to/Agent Coding.app"
#
# Why not always ad hoc: macOS files a privacy grant (Screen Recording, Accessibility, ...)
# under the app's designated requirement. With a certificate that is "this bundle id, signed
# by this certificate", which a rebuild leaves unchanged. Ad hoc it is the binary's hash, so
# every install_app orphaned the grants and "Agent Coding would like to record this
# computer's screen" came back although Settings showed it as allowed (2026-11-14).
set -e
APP="$1"
[ -d "$APP" ] || { echo "sign.sh: no app bundle at '$APP'" >&2; exit 1; }
# First valid code-signing identity, by SHA-1 so a duplicated name cannot be ambiguous.
IDENTITY=$(security find-identity -v -p codesigning | awk '$2 ~ /^[0-9A-F]{40}$/ {print $2; exit}')
if [ -z "$IDENTITY" ]; then
  IDENTITY="-"
  echo "sign.sh: no signing certificate in the keychain; signing ad hoc (privacy grants will not survive a rebuild)" >&2
fi
# codesign refuses a bundle carrying Finder attributes ("resource fork, Finder information, or
# similar detritus not allowed"), so strip them first. Only sign a copy OUTSIDE this project:
# ~/Documents is iCloud-synced and re-tags dist/...app the instant the attributes are removed,
# so signing there always fails. install_app signs the copy in /Applications.
n=0
until xattr -cr "$APP" && codesign --force --deep --sign "$IDENTITY" "$APP"; do
  n=$((n + 1))
  [ "$n" -lt 4 ] || { echo "sign.sh: codesign failed after $n attempts" >&2; exit 1; }
  sleep 1
done
codesign --verify --deep --strict "$APP"
echo "sign.sh: signed $(basename "$APP") with ${IDENTITY}"
