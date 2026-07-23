# Directory Structure

```text
.
├── src/
│   ├── agent/              orchestration and clarification/research loop
│   ├── cli/                setup, OAuth, and health commands
│   ├── core/               domain contracts, policy, and QueryCache port
│   ├── providers/llm/      model-provider adapters
│   ├── storage/            persistence, encryption, and tiered-cache adapters
│   ├── tui/                OpenTUI terminal adapter
│   ├── app.ts              composition root
│   ├── config.ts           validated environment configuration
│   └── index.ts            terminal entry point
├── skills/
│   ├── asana/
│   │   ├── analytics/      pure grouping, averages, and forecasts
│   │   ├── auth/           OAuth provider and encrypted token store
│   │   ├── queries/        normalized created/assigned query services
│   │   ├── retrieval/      MCP parsing, exhaustive scans, and pagination
│   │   ├── time/           timezone-aware ranges and calendar buckets
│   │   ├── tools/          tool contracts and evidence-producing handlers
│   │   ├── index.ts        compatibility exports
│   │   └── SKILL.md        operator-facing behavior
│   ├── aws/                AWS SDK read tools, manifest, and documentation
│   └── notion/             Notion read tools, manifest, and documentation
├── tests/                  unit, contract, and end-to-end tests
├── .data/
│   ├── cache/              ignored AES-256-GCM query-cache L2
│   └── secrets/            ignored encryption key and Asana tokens
├── Dockerfile
├── docker-compose.yml
├── railway.json
└── *.md                    product and engineering documentation
```

`src/core/cache.ts` defines stable keys, cache metadata, and 15-minute open/24-hour historical TTL policy. `src/storage/query-cache.ts` implements memory L1, encrypted file L2, strict expiry, and singleflight; `src/storage/encryption.ts` is shared with Asana token storage.

Dependencies point inward: terminal, storage, LLM, and vendor skills depend on core interfaces; core does not depend on those adapters. `src/app.ts` is the composition root and selects the local cache implementation. A future Redis/shared adapter, and AWS or Notion query services, can use the same core port.
