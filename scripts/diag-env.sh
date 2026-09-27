#!/usr/bin/env bash
# Exercise deploy.sh's tool-discovery logic without deploying anything.
# Extracts the find_tool function and runs it, so a regression in path handling
# is caught here rather than halfway through a real CloudFormation create.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Pull the find_tool function out of deploy.sh so we test the real thing.
# shellcheck disable=SC1090
eval "$(sed -n '/^find_tool() {/,/^}/p' "$SCRIPT_DIR/deploy.sh")"

if ! declare -f find_tool >/dev/null 2>&1; then
  echo "  FAIL  could not extract find_tool from deploy.sh"
  exit 1
fi
echo "  PASS  find_tool extracted from deploy.sh"
echo

fails=0
for tool in aws gh; do
  resolved="$(find_tool "$tool" || true)"
  if [ -z "$resolved" ]; then
    echo "  FAIL  $tool not found"
    fails=$((fails + 1))
    continue
  fi

  echo "  PASS  $tool resolved"
  echo "          path : $resolved"
  echo "          byname: $(command -v "$tool" >/dev/null 2>&1 && echo yes || echo 'no (absolute path used)')"

  if [ -x "$resolved" ] || [ -f "$resolved" ]; then
    version="$("$resolved" --version 2>&1 | head -1)"
    if [ -n "$version" ]; then
      echo "          runs: $version"
    else
      echo "  WARN  $tool did not report a version"
    fi
  fi
  echo
done

# The specific failure that started this: a PATH entry containing a space.
spaced="$(find_tool aws || true)"
if [ -n "$spaced" ]; then
  case "$spaced" in
    *"Program Files"*)
      if command -v aws >/dev/null 2>&1; then
        echo "  PASS  handles a PATH entry containing a space"
      else
        echo "  PASS  handles a PATH entry containing a space (this shell cannot resolve"
        echo "        'aws' by name, which is exactly the case being fixed)"
      fi
      ;;
    *)
      echo "  PASS  resolved aws from a space-free location"
      ;;
  esac
fi

if [ "$fails" -eq 0 ]; then
  echo "  TOOL DISCOVERY OK"
  exit 0
fi
echo "  TOOL DISCOVERY: $fails tool(s) unresolved"
exit 1
echo "shell bash: $BASH_VERSION"
echo "uname    : $(uname -srm 2>/dev/null || echo unknown)"
echo "WSL distro: ${WSL_DISTRO_NAME:-<none - not running under WSL>}"
echo "MSYSTEM  : ${MSYSTEM:-<none - not a Git Bash / MSYS shell>}"
echo

echo "--- PATH entries mentioning aws/amazon ---"
found=0
echo "$PATH" | tr ':' '\n' | while read -r entry; do
  case "$entry" in
    *[Aa][Ww][Ss]*|*[Aa]mazon*)
      echo "  $entry"
      ;;
  esac
done
echo

echo "--- command -v aws ---"
if command -v aws >/dev/null 2>&1; then
  echo "  resolved: $(command -v aws)"
  aws --version
else
  echo "  NOT resolvable by name"
  echo
  echo "  Searching PATH entries for an aws binary anyway..."
  IFS=':' read -r -a entries <<< "$PATH"
  for entry in "${entries[@]}"; do
    for candidate in "$entry/aws" "$entry/aws.exe"; do
      if [ -x "$candidate" ] || [ -f "$candidate" ]; then
        echo "    found: $candidate"
        echo "    runs : $("$candidate" --version 2>&1 | head -1)"
      fi
    done
  done
  echo
  echo "  If a file was found above but 'command -v aws' failed, the cause is"
  echo "  almost certainly a SPACE in a PATH entry (e.g. 'Program Files')."
  echo "  Linux splits PATH on ':' and cannot handle a space in an entry name."
  echo
  echo "  Fixes, best first:"
  echo "    1. Run this script from Git Bash instead of WSL:"
  echo "         \"C\\Program Files\\Git\\bin\\bash.exe\" scripts/deploy.sh"
  echo "    2. Or symlink the CLI into a space-free directory that is on PATH:"
  echo "         sudo ln -s \"/mnt/c/Program Files/Amazon/AWSCLIV2/aws.exe\" /usr/local/bin/aws"
  echo "    3. Or skip bash entirely and run the equivalent commands from PowerShell."
fi
echo
echo "--- gh (GitHub CLI) ---"
command -v gh >/dev/null 2>&1 && gh --version | head -1 || echo "  gh not resolvable either"
