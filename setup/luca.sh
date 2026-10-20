#!/usr/bin/env bash
# One-time setup for Luca's Wishlist: his own copy of the server, GitHub permission to
# keep it updated, and his daily stock check. Safe to run again.
#   curl -sL https://raw.githubusercontent.com/alyssamanse/MerrittsCloset/main/setup/luca.sh | bash
set -uo pipefail
PROJECT=merrittscloset-4d74f
REGION=us-central1
URL=https://luca-api-767635696368.us-central1.run.app
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

gcloud config set project "$PROJECT" >/dev/null 2>&1

say "1/4 Getting the code…"
rm -rf "$HOME/MerrittsCloset-setup"
git clone -q --depth 1 https://github.com/alyssamanse/MerrittsCloset.git "$HOME/MerrittsCloset-setup" || { echo "Couldn't download the code."; exit 1; }
cd "$HOME/MerrittsCloset-setup"

say "2/4 Creating Luca's server (takes 3–5 minutes, keep this tab open)…"
gcloud run deploy luca-api --source functions --function api --base-image nodejs22 \
  --region "$REGION" --allow-unauthenticated --max-instances 1 --timeout 300 --quiet \
  --service-account 767635696368-compute@developer.gserviceaccount.com \
  --set-env-vars "^@^WISHLIST_ID=w_8nq00X41XkIsTMvl5GJT@OWNER_EMAIL=alyssamanse@gmail.com@ALLOWED_ORIGINS=https://alyssamanse.github.io@BABY_NAME=Luca@SITE_TITLE=Luca's Wishlist@SITE_URL=https://alyssamanse.github.io/MerrittsCloset/luca/@ALERT_FROM=Luca's Wishlist <alerts@alerts.merrittjean.com>@ALERT_ACCENT=#2E5E7E@CRON_AUDIENCE=$URL/cron/daily" \
  --set-secrets RESEND_API_KEY=resend-api-key:latest || { echo "The server step failed. Copy the lines above and send them to Claude."; exit 1; }

say "3/4 Letting GitHub keep it up to date…"
gcloud run services add-iam-policy-binding luca-api --region "$REGION" --quiet \
  --member=serviceAccount:github-deployer@$PROJECT.iam.gserviceaccount.com --role=roles/run.developer >/dev/null \
  && echo "Done." || echo "That step failed (send Claude the message above)."

say "4/4 Scheduling the daily stock check (6:50am Central)…"
if gcloud scheduler jobs describe luca-daily-check --location "$REGION" >/dev/null 2>&1; then
  echo "Already scheduled."
else
  gcloud scheduler jobs create http luca-daily-check --location "$REGION" \
    --schedule "50 6 * * *" --time-zone "America/Chicago" \
    --uri "$URL/cron/daily" --http-method POST \
    --oidc-service-account-email closet-scheduler@$PROJECT.iam.gserviceaccount.com \
    --oidc-token-audience "$URL/cron/daily" --attempt-deadline 320s >/dev/null \
    && echo "Scheduled." || echo "That step failed (send Claude the message above)."
fi

say "All set. Luca's server:"
gcloud run services describe luca-api --region "$REGION" --format='value(status.url)'
echo "Next: open https://alyssamanse.github.io/MerrittsCloset/luca/ and tap 'Sign in to edit'."
