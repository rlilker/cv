#!/usr/bin/env bash
# =============================================================================
#  One-shot deploy for ryanlilker.com.
#
#  Run this yourself — it needs your AWS credentials, which is exactly why it
#  is a script rather than something the assistant ran for you.
#
#  Prerequisites: AWS CLI v2, configured (`aws configure` or a named profile),
#  and the domain's nameservers already pointing at this account's Route 53.
#
#  Usage:
#     bash scripts/deploy.sh                       # default region + profile
#     AWS_PROFILE=prod bash scripts/deploy.sh
#
#  Idempotent: safe to re-run. It will not delete the bucket.
# =============================================================================
set -euo pipefail

STACK_NAME="${STACK_NAME:-cv-site}"
DOMAIN="${DOMAIN:-ryanlilker.com}"
GITHUB_ORG="${GITHUB_ORG:-rlilker}"
GITHUB_REPO="${GITHUB_REPO:-cv}"
REGION="${REGION:-us-east-1}"

TEMPLATE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/infra/cloudformation.yml"

# Everything is created in us-east-1 on purpose:
#   - ACM certificates used by CloudFront MUST live in us-east-1.
#   - CloudFront, IAM and Route 53 are all global, so their region is irrelevant.
#   - S3 in us-east-1 costs nothing extra: traffic from S3 to CloudFront is free.
# One region for the whole stack avoids a cross-region parameter and keeps this
# to a single command.
say() { printf '\n\033[1;36m==>\033[0m %s\n' "$1"; }
die() { printf '\n\033[1;31mERROR:\033[0m %s\n' "$1" >&2; exit 1; }

command -v aws >/dev/null || die "The AWS CLI is not on PATH. Install it: https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html"
# -----------------------------------------------------------------------------
#  Tool discovery
#
#  Under WSL the Windows PATH is translated into Linux form, but an entry such
#  as "/mnt/c/Program Files/Amazon/AWSCLIV2" contains a space. Linux splits
#  PATH on ':' and cannot cope with that, so `aws` runs perfectly well yet
#  `command -v aws` finds nothing. Rather than make you work around a shell
#  quirk, resolve the tools here and export an absolute path. The script then
#  behaves the same from WSL, Git Bash, Linux and macOS.
# -----------------------------------------------------------------------------
find_tool() {
  local name="$1"
  # 1. Already resolvable by name (Linux, macOS, or a clean PATH).
  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
    return 0
  fi

  # 2. Scan every PATH entry, tolerating spaces inside the entry.
  local entry candidate
  local entries=()
  IFS=':' read -r -a entries <<< "$PATH"
  for entry in "${entries[@]}"; do
    for candidate in "$entry/$name" "$entry/$name.exe"; do
      if [ -f "$candidate" ]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done
  done

  # 3. Well-known Windows install locations, for PATH entries that were dropped.
  for entry in \
    "/mnt/c/Program Files/Amazon/AWSCLIV2" \
    "/c/Program Files/Amazon/AWSCLIV2" \
    "/mnt/c/Program Files/GitHub CLI" \
    "/c/Program Files/GitHub CLI" \
    "$HOME/AppData/Local/Programs/Amazon/AWSCLI" \
    "/usr/local/bin"; do
    for candidate in "$entry/$name" "$entry/$name.exe"; do
      if [ -f "$candidate" ]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done
  done

  return 1
}

if ! command -v aws >/dev/null 2>&1; then
  AWS_BIN="$(find_tool aws || true)"
  [ -n "$AWS_BIN" ] || die "Could not find the AWS CLI.

  Looked on PATH and in the usual install locations.
  Install it with:  winget install Amazon.AWSCLI
  Then run:  bash scripts/diag-env.sh   (prints a full diagnosis)"
  export AWS_BIN
  aws() { "$AWS_BIN" "$@"; }
  echo "    note: 'aws' is not resolvable by name here (a PATH entry contains a"
  echo "          space, which Linux cannot handle). Using: $AWS_BIN"
else
  AWS_BIN="$(command -v aws)"
fi

if ! command -v gh >/dev/null 2>&1; then
  GH_BIN="$(find_tool gh || true)"
  [ -n "$GH_BIN" ] || die "Could not find the GitHub CLI (gh).

  It is needed to set the repository secrets automatically.
  Install it with:  winget install GitHub.cli"
  export GH_BIN
  gh() { "$GH_BIN" "$@"; }
  echo "    note: 'gh' is not resolvable by name here. Using: $GH_BIN"
else
  GH_BIN="$(command -v gh)"
fi

[ -f "$TEMPLATE" ] || die "Template not found at $TEMPLATE"

# ── Identity ────────────────────────────────────────────────────────────────
say "Checking credentials"
aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1 \
  || die "No working credentials for region $REGION. Run: aws configure  (or set AWS_PROFILE)"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "    account $ACCOUNT_ID, region $REGION"

# ── Route 53 sanity check ───────────────────────────────────────────────────
say "Looking for an existing hosted zone for $DOMAIN"
ZONE_ID=$(aws route53 list-hosted-zones-by-name --dns-name "$DOMAIN." \
  --query "HostedZones[?Name=='$DOMAIN.' && !PrivateZone].Id | [0]" \
  --output text --region us-east-1 2>/dev/null || true)
ZONE_ID="${ZONE_ID:-}"

if [ -n "$ZONE_ID" ] && [ "$ZONE_ID" != "None" ]; then
  echo "    found hosted zone $ZONE_ID - the stack will create the DNS records for you"
  CREATE_ZONE=false
else
  echo "    no hosted zone found in this account"
  echo "    -> the stack will create one. You will then need to point $DOMAIN's"
  echo "       nameservers at Route 53 (see the README) before the certificate"
  echo "       can validate. Everything else works regardless."
  CREATE_ZONE=true
fi

# ── Deploy ──────────────────────────────────────────────────────────────────
say "Deploying the CloudFormation stack (this takes 3-8 minutes)"
aws cloudformation deploy \
  --template-file "$TEMPLATE" \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
      "DomainName=$DOMAIN" \
      "GitHubOrg=$GITHUB_ORG" \
      "GitHubRepo=$GITHUB_REPO" \
      "CreateHostedZone=$CREATE_ZONE" \
  --no-fail-on-empty-changeset

# ── Report ──────────────────────────────────────────────────────────────────
say "Reading stack outputs"
out() { aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

BUCKET=$(out BucketName)
DIST_ID=$(out DistributionId)
ROLE_ARN=$(out DeployRoleArn)
CF_DOMAIN=$(out CloudFrontDomain)
SITE_URL=$(out SiteUrl)

cat <<SUMMARY

    Bucket          $BUCKET
    Distribution    $DIST_ID
    Deploy role     $ROLE_ARN
    CloudFront URL  https://$CF_DOMAIN/
    Site URL        $SITE_URL

SUMMARY

# ── Next steps ──────────────────────────────────────────────────────────────
say "Configuring GitHub (no AWS keys are stored - the workflow uses OIDC)"
gh secret set AWS_DEPLOY_ROLE_ARN --repo "$GITHUB_ORG/$GITHUB_REPO" --body "$ROLE_ARN"
gh secret set DISTRIBUTION_ID     --repo "$GITHUB_ORG/$GITHUB_REPO" --body "$DIST_ID"
gh variable set AWS_REGION  --repo "$GITHUB_ORG/$GITHUB_REPO" --body "$REGION"
gh variable set SITE_BUCKET --repo "$GITHUB_ORG/$GITHUB_REPO" --body "$BUCKET"
echo "    secrets and variables set"

say "Waiting for the ACM certificate to validate"
for i in $(seq 1 30); do
  STATUS=$(aws acm describe-certificate --certificate-arn "$(out CertificateArn)" \
    --region us-east-1 --query Certificate.Status --output text 2>/dev/null || echo UNKNOWN)
  printf '\r    certificate: %s   (%ss)' "$STATUS" "$((i * 10))"
  [ "$STATUS" = "ISSUED" ] && { printf '\n    certificate issued\n'; break; }
  sleep 10
done
printf '\n'

cat <<'DONE'

Next
----
  1. Check the site:   https://<cloudfront-host>/
     It works over HTTPS on the CloudFront hostname straight away.

  2. Once the certificate says ISSUED, create these two Route 53 records
     (type A, alias to the CloudFront distribution, "evaluate target
     health" OFF):
         ryanlilker.com
         www.ryanlilker.com

  3. Push to main. The Deploy workflow publishes all four pages and
     invalidates the cache.

Verify afterwards:  bash scripts/verify-live.sh
DONE
