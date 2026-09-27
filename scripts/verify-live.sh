#!/usr/bin/env bash
# =============================================================================
#  Verify the deployed site is actually live and correct.
#
#  Run this AFTER scripts/deploy.sh and after the first successful deploy.
#  Needs only curl, so it also works from a machine with no AWS CLI.
#
#  Usage:
#     bash scripts/verify-live.sh
#     SITE=https://ryanlilker.com bash scripts/verify-live.sh
# =============================================================================
set -uo pipefail

SITE="${SITE:-https://ryanlilker.com}"
PASS=0
FAIL=0

ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; [ -n "${2:-}" ] && printf '        %s\n' "$2"; FAIL=$((FAIL+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Fetch once and reuse. -L follows redirects; -s silent; -S shows errors.
BODY=$(curl -sSL --max-time 20 "$SITE" 2>/dev/null)
CODE=$(curl -sSL -o /dev/null -w '%{http_code}' --max-time 20 "$SITE" 2>/dev/null || echo "000")

head_ "Reachability"
[ "$CODE" = "200" ] && ok "GET $SITE -> 200" || bad "GET $SITE -> $CODE (expected 200)"

head_ "TLS"
if curl -sS --max-time 15 -o /dev/null "https://${SITE#https://}" 2>/dev/null; then
  ok "HTTPS works (certificate valid)"
else
  bad "HTTPS failed - the ACM certificate may still be pending validation"
fi

if curl -sS --max-time 15 -o /dev/null "http://${SITE#https://}" 2>/dev/null; then
  # CloudFront should upgrade this to HTTPS.
  REDIR=$(curl -sS -o /dev/null -w '%{redirect_url}' --max-time 15 "http://${SITE#https://}" 2>/dev/null || echo "")
  case "$REDIR" in
    https://*) ok "HTTP redirects to HTTPS" ;;
    *) bad "HTTP is not redirected to HTTPS" "CloudFront should force https" ;;
  esac
fi

head_ "Content"
[ -n "$BODY" ] || { bad "empty response body"; }

contains() {
  if printf '%s' "$BODY" | grep -qF "$1"; then ok "contains: $2"; else bad "missing: $2"; fi
}

contains "Ryan Lilker"      "name"
contains "Principal Software" "role"
contains "CMap Software"    "employer (CMap)"
contains "iSOFT plc"        "employer (iSOFT)"
contains "Blemain Group"    "employer (Blemain)"
contains "£7m"              "UTF-8 pound sign"
contains "Family Planner"   "projects link"
contains "application/ld+json" "JSON-LD structured data"

head_ "Pages"
for p in "/" "/family-planner/" "/family-planner/privacy/" "/family-planner/terms/"; do
  C=$(curl -sSL -o /dev/null -w '%{http_code}' --max-time 20 "${SITE}${p}" 2>/dev/null || echo "000")
  [ "$C" = "200" ] && ok "${p} -> 200" || bad "${p} -> $C"
done

head_ "Security headers"
H=$(curl -sSI --max-time 20 "$SITE" 2>/dev/null)
check_header() {
  if printf '%s' "$H" | grep -qi "$1"; then ok "$2"; else bad "$2 not present"; fi
}
check_header "strict-transport-security" "HSTS"
check_header "x-content-type-options"    "X-Content-Type-Options"
check_header "content-security-policy\|x-frame-options" "frame protection"
check_header "server: cloudfront\|via:.*cloudfront" "served by CloudFront"

head_ "Assets"
if printf '%s' "$BODY" | grep -q '_astro/'; then
  ok "hashed assets under /_astro/ (immutable cache)"
else
  bad "no /_astro/ assets found"
fi
if printf '%s' "$BODY" | grep -qi 'fonts.googleapis.com\|fonts.gstatic.com'; then
  bad "page loads fonts from Google (third-party request)"
else
  ok "fonts are self-hosted (no Google Fonts request)"
fi

printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32mAll %d live checks passed.\033[0m The site is live.\n\n' "$PASS"
  exit 0
else
  printf '\033[31m%d of %d live checks failed.\033[0m\n\n' "$FAIL" "$((PASS+FAIL))"
  cat <<'TROUBLESHOOT'

Most common causes:
  * Certificate still pending  -> ACM console, wait for ISSUED (a few minutes
                                  after DNS records exist, up to ~30 min).
  * 404 on a sub-page          -> the deploy workflow has not run yet. Push to
                                  main and watch the Actions tab.
  * Stale content              -> CloudFront cached it. Re-run the deploy, or:
                                    aws cloudfront create-invalidation \
                                      --distribution-id <DISTRIBUTION_ID> --paths "/*"
TROUBLESHOOT
  exit 1
fi
