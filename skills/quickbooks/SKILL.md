---
name: quickbooks-simulation
description: Answer financial questions using the fixed synthetic QuickBooks dataset while clearly distinguishing simulation from live accounting data.
---

# QuickBooks simulation

Every value returned by `QUICKBOOKS` is synthetic. Say so prominently in every answer that uses it.

Use `analyzeCustomerRevenue()` for biggest-client and revenue rankings, `analyzeServiceRevenue()` for Branding/Web/Video/Imaging mix, and `getProfitAndLoss()` for company-wide income and expense questions. Do not infer exact totals by manually summing truncated transaction samples. The Gatekeeper is read-only and has no live QuickBooks connection.
