# AWS

Reads cost history, commitment utilization, and inventory for EC2, RDS, S3, CloudFront, and WAF using AWS SDK v3.

## Authentication

Uses an IAM principal with `ReadOnlyAccess` plus billing visibility. Credentials come only from environment variables.

## Safety

Only read commands are registered. Results include date ranges, regions, currency/units, and resource identifiers so analytical claims remain traceable.

## Limits

Cost Explorer data may lag and requires separate billing permissions. Contract termination charges are not fully represented by utilization APIs; answers must state that limitation.
