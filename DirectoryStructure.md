# Directory Structure

```text
.
├── src/
│   ├── agent/              orchestration and clarification/research loop
│   ├── cli/                setup, OAuth, and health commands
│   ├── core/               provider-neutral domain contracts and policy
│   ├── providers/llm/      model-provider adapters
│   ├── storage/            persistence adapters
│   ├── tui/                OpenTUI terminal adapter
│   ├── app.ts              composition root
│   ├── config.ts           validated environment configuration
│   └── index.ts            terminal entry point
├── skills/
│   ├── asana/              MCP V2, OAuth, manifest, and documentation
│   ├── aws/                AWS SDK read tools, manifest, and documentation
│   └── notion/             Notion read tools, manifest, and documentation
├── tests/                  unit, contract, and end-to-end tests
├── .data/                  ignored local memory, audit, cache, and tokens
├── Dockerfile
├── docker-compose.yml
├── railway.json
└── *.md                    product and engineering documentation
```

Dependencies point inward: terminal, storage, LLM, and vendor skills depend on core interfaces; core does not depend on those adapters. `src/app.ts` is the composition root and the only place that chooses concrete providers.
