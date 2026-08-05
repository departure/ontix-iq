# AWS Gatekeeper

Least-privilege, read-only access to AWS identity, Cost Explorer, commitment utilization, EC2, RDS, and S3. Configure `AWS_ACCESS_KEY` and `AWS_ACCESS_KEY_SECRET` as Worker secrets and `AWS_REGIONS` as a comma-separated variable.

The API exposes no AWS mutations. Every request is authorized and logged as an observation.
