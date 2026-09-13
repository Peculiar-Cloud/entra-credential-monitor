# Container Image

Entra Credential Monitor is available as a rootless container image:

```sh
docker pull ghcr.io/peculiar-cloud/entra-credential-monitor:latest
```

The image uses a Chainguard Node runtime and runs as non-root UID/GID `65532`.
It has no long-running server, writable application state, exposed ports, or
volume requirement; it starts, scans, sends the report when configured, and
exits with the same code as the Node CLI.

## Run Locally

```sh
cp .env.example .env.local
docker run --rm --env-file .env.local ghcr.io/peculiar-cloud/entra-credential-monitor:latest
```

## Run From GitHub Actions

```yaml
name: Entra Credential Monitor

on:
  schedule:
    - cron: "0 15 1 * *"
  workflow_dispatch:

jobs:
  monitor:
    runs-on: ubuntu-latest
    steps:
      - name: Run monitor
        env:
          ENTRA_TENANT_ID: ${{ secrets.ENTRA_TENANT_ID }}
          ENTRA_CLIENT_ID: ${{ secrets.ENTRA_CLIENT_ID }}
          ENTRA_CLIENT_SECRET: ${{ secrets.ENTRA_CLIENT_SECRET }}
          ENTRA_TENANT_NAME: ${{ vars.ENTRA_TENANT_NAME }}
          RESEND_API_KEY: ${{ secrets.RESEND_API_KEY }}
          SENDER_EMAIL: ${{ vars.SENDER_EMAIL }}
          EMAIL_RECIPIENTS: ${{ secrets.EMAIL_RECIPIENTS }}
          WARNING_DAYS: ${{ vars.WARNING_DAYS || '30' }}
          SELF_MONITORING_WARNING_DAYS: ${{ vars.SELF_MONITORING_WARNING_DAYS || '60' }}
          EXPIRED_GRACE_DAYS: ${{ vars.EXPIRED_GRACE_DAYS || '90' }}
          REPORT_TIMEZONE: ${{ vars.REPORT_TIMEZONE || 'America/New_York' }}
          REPORT_BRAND_NAME: ${{ vars.REPORT_BRAND_NAME || 'Peculiar Cloud' }}
          REPORT_BRAND_URL: ${{ vars.REPORT_BRAND_URL || 'https://peculiar.cloud' }}
          LOG_LEVEL: ${{ vars.LOG_LEVEL || 'info' }}
          ALWAYS_SEND_REPORT: "false"
          HEALTHCHECKS_PING_URL: ${{ secrets.HEALTHCHECKS_PING_URL }}
        run: |
          docker run --rm \
            --env ENTRA_TENANT_ID \
            --env ENTRA_CLIENT_ID \
            --env ENTRA_CLIENT_SECRET \
            --env ENTRA_TENANT_NAME \
            --env RESEND_API_KEY \
            --env SENDER_EMAIL \
            --env EMAIL_RECIPIENTS \
            --env WARNING_DAYS \
            --env SELF_MONITORING_WARNING_DAYS \
            --env EXPIRED_GRACE_DAYS \
            --env REPORT_TIMEZONE \
            --env REPORT_BRAND_NAME \
            --env REPORT_BRAND_URL \
            --env LOG_LEVEL \
            --env ALWAYS_SEND_REPORT \
            --env HEALTHCHECKS_PING_URL \
            ghcr.io/peculiar-cloud/entra-credential-monitor:latest
```

## Tags

- `latest`: latest GitHub release.
- `main`: latest successful build from `main`.
- `X.Y.Z`, `X.Y`, and `X`: semantic-version aliases.

The package also has a weekly cleanup workflow that deletes old unreferenced
untagged versions and retired `sha-*` versions while preserving platform
manifests referenced by active tags.

## Verify Published Images

Release builds publish GitHub provenance attestations. After pulling an image,
verify the attestation with:

```sh
gh attestation verify oci://ghcr.io/peculiar-cloud/entra-credential-monitor:latest \
  -R Peculiar-Cloud/entra-credential-monitor
```
