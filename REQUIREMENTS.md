# REQUIREMENTS.md

# Ontix IQ

**Version:** 0.1 (Prototype)
**Status:** Active Development
**Target Customer:** DEPARTURE
**Primary User:** Art Bradshaw (CEO)

---

# Overview

Ontix IQ is an agentic executive intelligence platform that connects to multiple business systems, interprets information across those systems, and provides executives with natural-language insights and the ability to safely take action.

Unlike a traditional chatbot, Ontix IQ is intended to function as an Executive Operating System.

The system should:

- answer complex business questions
- create multi-step plans
- gather information from multiple sources
- remember important information about the organization and its executives
- proactively deliver scheduled reports and insights
- safely perform approved actions on behalf of users

This prototype will initially run locally but **must be architected for deployment to Railway** and should avoid infrastructure-specific assumptions so that future deployment to AWS or Cloudflare Temporary Accounts is straightforward.

---

# Long-Term North Star

Build a **shared intelligence engine with tenant-isolated context, customer-specific skills, and fully auditable actions.**

The application should eventually become a hosted SaaS platform where:

- one codebase serves many customers
- customer data is logically isolated
- new customers are onboarded through configuration instead of custom development
- new skills can be added without modifying the core platform

---

# Initial Customer

Company:

DEPARTURE

Industry:

Digital branding
Creative
Video production
Website development

Primary Executive:

Art Bradshaw
CEO

Additional Executive:

Emily Rex
Partner

---

# Initial Technology Stack

Frontend

- Nuxt 3
- Vite
- TypeScript
- Vue 3
- Tailwind CSS

Backend

- Node.js
- TypeScript

Database

- PostgreSQL
- pgvector extension

Cache / Job Queue

- Redis

Authentication

Implement a simple local login for the prototype.

The authentication layer should be replaceable later with:

- Auth.js
- Clerk
- Auth0
- Cognito

Deployment

Must run locally.

Architecture should support deployment to:

- Railway
- Cloudflare Temporary Accounts for Web Agents
- AWS (future)

---

# Deployment Requirements

The application should include:

- Dockerfile
- docker-compose.yml
- Railway-compatible configuration
- environment-variable driven configuration
- zero hardcoded credentials

The application should be structured so an AI coding agent can eventually:

- deploy to Railway
- update Railway deployments
- monitor deployment health
- roll back failed deployments

Do not assume Railway credentials exist yet.

---

# Architecture

Organize the application into these logical modules.

## Frontend

Dashboard

Chat

Settings

Memory Viewer

Skills

Executive Profile

Notifications

Audit Log

---

## Backend API

REST or RPC endpoints for:

Authentication

Chat

Memory

Search

Skill execution

Scheduling

Executive profile

Dashboard widgets

---

## Agent Runtime

The agent should never directly access external systems.

Instead:

User

↓

Planner

↓

Skills

↓

Retriever

↓

Reasoning

↓

Answer

↓

Optional Action

Every external action must flow through a registered Skill.

---

# LLM

Primary model:

GPT 5.6 Sol

The application should abstract model providers behind an interface.

Do not tightly couple the application to any one model provider.

Future providers may include:

- OpenAI
- Azure OpenAI
- Amazon Bedrock
- Anthropic

---

# Skills

Skills are modular integrations.

Each skill owns:

authentication

permissions

schemas

actions

documentation

Future skills should be installable without changing application code.

Suggested structure:

/skills

/asana

/aws

/notion

/google

/slack

Each skill should contain:

SKILL.md

manifest.json

actions

schemas

authentication

---

# Initial Skills

## Asana

Connection

MCP

Purpose

Project management

Use for:

projects

tasks

project managers

project counts

client work

resource allocation

---

## AWS

Connection

IAM ReadOnlyAccess

Purpose

Infrastructure

Use for:

AWS costs

AWS inventory

infrastructure

recommendations

architecture

Reserved Instances

Savings Plans

---

## Notion

Connection

API token

Purpose

Knowledge management

Use for:

subscriptions

internal documentation

company policies

software inventory

notes

---

# Retrieval

When a user asks a question:

The agent should determine:

- which skills are required
- whether clarification is needed
- what information must be gathered
- whether existing memory answers the question
- whether external retrieval is required

The agent may ask clarifying questions before executing a plan.

---

# Example Executive Questions

The first customer should eventually be able to answer questions including:

- Based on number of projects, who is our biggest client in 2026 to date?
- What will it cost us to break our AWS contract?
- Given our tech needs and infrastructure, what would be a good alternative to AWS?
- What kind of corporation should DEPARTURE be to gain the most tax benefits?
- How much has DEPARTURE spent on subscriptions this year?
- What percentage of our projects in 2026 have involved video work?
- What percentage of our projects in 2026 have involved web development?
- What percentage of our projects in 2026 have involved branding, creative or design?
- How many projects are we averaging per month in 2026?
- How many projects have we had with gChem in 2026?
- How many projects have we had in the first half of 2026 compared to the first half of 2025?
- Which project manager has been assigned the most tasks in 2026?
- How many projects have we averaged per month over the past three years?
- How many RFPs did we receive in 2025 compared to 2026?
- If we grow our current number of projects by 15%, how many will we have next month?
- Based on the past three years, how many projects can we expect during Q1 2027?
- Which quarter of 2027 is most likely to be our busiest?
- What is likely to grow faster: Branding or Web Development?

The application should be designed so new executive questions require configuration rather than new code whenever possible.

---

# Executive Memory

The system should maintain an evolving Executive Profile.

This profile represents durable knowledge about Art Bradshaw and should improve over time.

Implement a memory system using:

- canonical
- draft
- deprecated

knowledge states

Separate:

episodic memory

(events)

from

semantic memory

(long-term facts)

Use:

- semantic retrieval
- keyword retrieval

to locate memories.

Contradictions should never overwrite canonical knowledge automatically.

Instead:

new information

↓

compare

↓

rank confidence

↓

promote only when confidence is sufficient

The system should maintain a complete audit trail of memory changes.

---

# Dashboard

Include a modern executive dashboard.

Widgets may include:

Today's Brief

Open Projects

AWS Spend

Subscription Spend

Recently Learned

Upcoming Deadlines

Notifications

Recent Conversations

Saved Insights

The dashboard layout should eventually become customizable.

---

# Scheduled Intelligence

Support recurring jobs.

Examples:

Daily Executive Brief

Weekly Sales Summary

Monthly Infrastructure Review

Subscription Renewal Report

Upcoming Deadlines

The scheduler should eventually support:

daily

weekly

monthly

custom cron

---

# Security

Never expose secrets.

Use environment variables.

Store credentials securely.

Encrypt sensitive information.

Log:

tool execution

memory updates

external actions

user approvals

Every action taken by the AI must be auditable.

---

# Future SaaS Requirements

The architecture should support:

multiple organizations

tenant isolation

branding

custom dashboards

custom skills

organization profiles

feature flags

billing

role-based permissions

approval workflows

---

# Coding Guidelines

Prefer:

small modules

strong typing

clear interfaces

dependency injection

provider abstraction

Avoid:

global state

provider lock-in

tight coupling

---

# Success Criteria

A successful prototype should allow Art Bradshaw to:

- log in
- chat naturally with Ontix IQ
- ask business questions
- retrieve information from Asana, AWS, and Notion
- receive answers with citations of which skills were used
- ask follow-up questions naturally
- observe that the system remembers useful long-term information
- view executive dashboards
- receive scheduled executive briefings

The architecture should make onboarding the second customer dramatically easier than onboarding the first by emphasizing reusable skills, reusable infrastructure, configuration over customization, and a shared intelligence engine.