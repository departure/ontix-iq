# Memory

Ontix IQ separates conversation history from durable executive memory.

## Model

Every memory belongs to an organization and user and has:

- kind: `semantic` for durable facts or `episodic` for events
- state: `canonical`, `draft`, or `deprecated`
- confidence, provenance, and timestamps
- an optional superseded record

The terminal recognizes explicit requests beginning with “remember…” and stores them as draft semantic memory. Drafts improve retrieval but do not silently replace canonical knowledge.

## Contradictions

New canonical-looking content is compared with existing canonical records. A likely conflict is demoted to draft. This conservative rule is intentionally simple; automatic promotion requires stronger evidence ranking and an executive review surface.

## Retrieval

The local adapter combines normalized keyword overlap with state filtering. The `MemoryStore` port is designed for a later hybrid keyword and pgvector implementation. Retrieval always includes tenant filters.

## Audit

Memory changes are append-only events. The prototype does not edit `ORGANIZATION.md` automatically. A future memory viewer should support review, promotion, deprecation, and provenance inspection.

## TODO

- Add embedding-based retrieval when PostgreSQL/pgvector is available.
- Add a confirmation workflow before promotion or canonical replacement.
- Add retention and export policies after customer security requirements are known.
