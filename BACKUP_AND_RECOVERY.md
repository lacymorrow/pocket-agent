# Backup & Disaster Recovery

This document describes how to safeguard Pocket-Agent data and quickly recover from disasters.

## What Needs to Be Backed Up?

| Component | Location | Recommended Method |
|-----------|----------|--------------------|
| Chat HTML snapshots | In-memory only (server process) | **Persist** to S3 / object storage every `n` minutes using the `/chat-update` webhook as trigger. |
| Server logs | stdout / `docker logs` | Ship to Elasticsearch or Loki via Promtail. |
| Configuration / Secrets | `.env` / cloud secrets manager | Version secrets in a secure vault (e.g. 1Password, AWS Secrets Manager). |

## Backup Strategy

1. **Snapshots** – Stream chat HTML to an append-only bucket (`s3://pocket-agent-backups/chats/YYYY/MM/DD/`).
2. **Daily images** – Build and push Docker images using the Release workflow; images are immutable backups of code.
3. **Configuration** – Store infra as code (IaC) in Git. Secrets reside in a secrets manager; nightly export with encryption.

Retention: 14 days for snapshots, 90 days for logs, indefinitely for release images.

## Disaster Recovery Plan

1. **Loss of server container** → Re-deploy latest image (`docker compose up -d`).
2. **Data corruption** → Restore latest S3 snapshot into new container; verify integrity.
3. **Cloud region outage** → Deploy in standby region using the same IaC, restore from cross-region replicated S3 bucket.

Recovery Time Objective (RTO): **15 minutes**  
Recovery Point Objective (RPO): **<5 minutes** (due to streaming snapshots).