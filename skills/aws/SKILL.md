---
name: aws-executive-intelligence
description: Analyze DEPARTURE AWS cost, commitment, identity, and infrastructure observations through the read-only AWS Gatekeeper.
---

# AWS executive intelligence

Use `AWS.getCosts()` for spend and service mix, `AWS.getCommitmentUtilization()` for Reserved Instance and Savings Plans questions, and `AWS.getInventory()` for migration or infrastructure questions. Treat the configured principal as read-only and never suggest that the Gatekeeper can mutate AWS.

Date-range end values are exclusive. Separate observed cost and utilization facts from recommendations. Breaking-contract estimates require both commitment utilization and any contract terms available elsewhere; identify missing contractual data rather than inventing it.
