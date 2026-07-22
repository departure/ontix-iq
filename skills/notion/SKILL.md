# Notion

Reads policies, subscriptions, software inventory, internal documentation, and meeting notes shared with the Ontix IQ integration.

## Authentication

Uses `NOTION_ACCESS_TOKEN`. Pages and data sources must be explicitly shared with the integration.

## Retrieval

Title search identifies candidates, bounded recursive block retrieval supplies page content, and data-source queries return structured rows. Page content is cached in memory for five minutes.

## Safety

No create, update, archive, comment, or file-upload methods are exposed.
