#!/usr/bin/env python3
"""Build a PDF briefing from Ontix IQ grind Run 1 + Run 2."""

from __future__ import annotations

import csv
import re
import textwrap
from pathlib import Path

from reportlab.lib.colors import Color, HexColor, white
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "grind-results" / "ontix-iq-grind-run1-run2-briefing.pdf"
RUN1 = ROOT / "grind-results" / "grind-2026-07-27T22-46-29.188Z.csv"
RUN2 = ROOT / "grind-results" / "grind-2026-07-28-data-gaps-complete.csv"

NAVY = HexColor("#0B1020")
SKY = HexColor("#0EA5E9")
SLATE = HexColor("#334155")
MUTED = HexColor("#64748B")
INK = HexColor("#0F172A")
SOFT = HexColor("#F8FAFC")
CARD = HexColor("#EEF2FF")
STRONG = HexColor("#059669")
GAP = HexColor("#DC2626")
AMBER = HexColor("#D97706")


def load_run(path: Path) -> tuple[list[dict], dict[int, dict], dict[int, int], dict[int, str | None]]:
    rows = list(csv.DictReader(path.open()))
    finals: dict[int, dict] = {}
    clarifs: dict[int, int] = {}
    questions: dict[int, str | None] = {}
    for row in rows:
        i = int(row["iteration"])
        if row["role"] == "user" and row["turn"] == "1":
            questions[i] = row
        if row["role"] == "assistant" and row["is_clarification"] == "true":
            clarifs[i] = clarifs.get(i, 0) + 1
        if row["role"] == "assistant" and row["is_clarification"] == "false":
            finals[i] = row
    return rows, finals, clarifs, questions


def clean_md(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"(?m)^#{1,6}\s*", "", text)

    # Protect markdown spans, escape XML, then restore as ReportLab markup.
    tokens: list[str] = []

    def stash(html: str) -> str:
        tokens.append(html)
        return f"@@T{len(tokens) - 1}@@"

    text = re.sub(r"\*\*(.+?)\*\*", lambda m: stash(f"<b>{_xml(m.group(1))}</b>"), text)
    text = re.sub(
        r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)",
        lambda m: stash(f"<i>{_xml(m.group(1))}</i>"),
        text,
    )
    text = re.sub(
        r"`([^`]+)`",
        lambda m: stash(f"<font face='Courier'>{_xml(m.group(1))}</font>"),
        text,
    )
    text = re.sub(
        r"\[([A-Z]+-[a-z0-9]+)\]",
        lambda m: stash(f"<font color='#0EA5E9'>[{_xml(m.group(1))}]</font>"),
        text,
    )
    text = _xml(text)
    for i, tok in enumerate(tokens):
        text = text.replace(f"@@T{i}@@", tok)

    lines = []
    for line in text.split("\n"):
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("- "):
            lines.append("• " + stripped[2:])
        else:
            lines.append(stripped)
    return "<br/>".join(lines)


def _xml(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def truncate_answer(text: str, max_chars: int = 1450) -> str:
    text = text.strip()
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars].rsplit(" ", 1)[0]
    return cut + "…"


def styles():
    base = getSampleStyleSheet()
    return {
        "cover_kicker": ParagraphStyle(
            "cover_kicker",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=10,
            textColor=SKY,
            tracking=1,
            spaceAfter=8,
        ),
        "cover_title": ParagraphStyle(
            "cover_title",
            parent=base["Normal"],
            fontName="Helvetica-Bold",
            fontSize=26,
            leading=30,
            textColor=NAVY,
            spaceAfter=10,
        ),
        "cover_sub": ParagraphStyle(
            "cover_sub",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=11,
            leading=15,
            textColor=MUTED,
            spaceAfter=18,
        ),
        "h2": ParagraphStyle(
            "h2",
            parent=base["Normal"],
            fontName="Helvetica-Bold",
            fontSize=14,
            textColor=NAVY,
            spaceBefore=10,
            spaceAfter=8,
        ),
        "body": ParagraphStyle(
            "body",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=9.5,
            leading=13,
            textColor=INK,
            alignment=TA_JUSTIFY,
            spaceAfter=6,
        ),
        "bullet": ParagraphStyle(
            "bullet",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=9.5,
            leading=13,
            textColor=INK,
            leftIndent=12,
            spaceAfter=3,
        ),
        "meta": ParagraphStyle(
            "meta",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=8.5,
            leading=11,
            textColor=MUTED,
            spaceAfter=4,
        ),
        "label": ParagraphStyle(
            "label",
            parent=base["Normal"],
            fontName="Helvetica-Bold",
            fontSize=8,
            textColor=MUTED,
            spaceBefore=8,
            spaceAfter=3,
        ),
        "question": ParagraphStyle(
            "question",
            parent=base["Normal"],
            fontName="Helvetica-Bold",
            fontSize=12,
            leading=16,
            textColor=NAVY,
            spaceAfter=8,
        ),
        "answer": ParagraphStyle(
            "answer",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=9.5,
            leading=13,
            textColor=INK,
            alignment=TA_JUSTIFY,
            spaceAfter=6,
        ),
        "why": ParagraphStyle(
            "why",
            parent=base["Normal"],
            fontName="Helvetica-Oblique",
            fontSize=9,
            leading=12,
            textColor=SLATE,
            spaceBefore=6,
        ),
        "badge": ParagraphStyle(
            "badge",
            parent=base["Normal"],
            fontName="Helvetica-Bold",
            fontSize=8,
            textColor=white,
            alignment=TA_CENTER,
        ),
        "footer": ParagraphStyle(
            "footer",
            parent=base["Normal"],
            fontName="Helvetica",
            fontSize=8,
            textColor=MUTED,
            alignment=TA_CENTER,
        ),
        "page_title": ParagraphStyle(
            "page_title",
            parent=base["Normal"],
            fontName="Helvetica-Bold",
            fontSize=11,
            textColor=SKY,
            spaceAfter=4,
        ),
    }


def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(HexColor("#E2E8F0"))
    canvas.setLineWidth(0.5)
    canvas.line(0.75 * inch, 0.55 * inch, letter[0] - 0.75 * inch, 0.55 * inch)
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(0.75 * inch, 0.35 * inch, "Ontix IQ · Question Grind Briefing")
    canvas.drawRightString(letter[0] - 0.75 * inch, 0.35 * inch, f"{doc.page}")
    canvas.restoreState()


def badge_table(label: str, color: Color, width: float = 1.35 * inch):
    s = styles()
    data = [[Paragraph(label.upper(), s["badge"])]]
    t = Table(data, colWidths=[width])
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), color),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )
    return t


def example_page(
    story,
    *,
    run_label: str,
    example_num: int,
    total: int,
    iteration: int,
    question: str,
    answer: str,
    relatedness: str,
    signal: str,
    why: str,
    evidence: int,
    tools_ok: int,
    tools_fail: int,
    clarifs: int,
    duration_ms: int | None,
    missing_source: str | None = None,
):
    s = styles()
    signal_color = STRONG if signal == "Strong signal" else GAP if signal == "Source gap" else AMBER
    story.append(Paragraph(f"{run_label} · Example {example_num} of {total}", s["page_title"]))
    story.append(Paragraph(f"Iteration {iteration}", s["question"]))

    meta_bits = [
        f"<b>Relatedness:</b> {relatedness}",
        f"<b>Evidence:</b> {evidence}",
        f"<b>Tools:</b> {tools_ok} ok / {tools_fail} fail",
        f"<b>Clarifications:</b> {clarifs}",
    ]
    if duration_ms is not None:
        meta_bits.append(f"<b>Latency:</b> {duration_ms/1000:.1f}s")
    if missing_source:
        meta_bits.append(f"<b>Intended gap:</b> {missing_source}")

    header = Table(
        [[badge_table(signal, signal_color, 1.4 * inch), Paragraph(" · ".join(meta_bits), s["meta"])]],
        colWidths=[1.55 * inch, 5.2 * inch],
    )
    header.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    story.append(header)
    story.append(Spacer(1, 0.15 * inch))

    story.append(Paragraph("QUESTION", s["label"]))
    qbox = Table([[Paragraph(question, s["question"])]], colWidths=[6.75 * inch])
    qbox.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), SOFT),
                ("BOX", (0, 0), (-1, -1), 0.5, HexColor("#CBD5E1")),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
                ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ]
        )
    )
    story.append(qbox)

    story.append(Paragraph("ONTIX IQ ANSWER", s["label"]))
    abox = Table(
        [[Paragraph(clean_md(truncate_answer(answer)), s["answer"])]],
        colWidths=[6.75 * inch],
    )
    abox.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), HexColor("#F0F9FF")),
                ("BOX", (0, 0), (-1, -1), 0.5, HexColor("#BAE6FD")),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
                ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ]
        )
    )
    story.append(abox)
    story.append(Paragraph(f"<b>Why this example:</b> {why}", s["why"]))
    story.append(PageBreak())


def summary_stats(finals, clarifs, questions):
    from collections import Counter

    n = len(finals)
    with_ev = sum(1 for r in finals.values() if int(r["evidence_count"]) > 0)
    zero_ev = n - with_ev
    clar_iters = sum(1 for i in finals if clarifs.get(i, 0) > 0)
    tool_fail = sum(int(r["tool_failures"]) for r in finals.values())
    tool_ok = sum(int(r["tool_successes"]) for r in finals.values())
    relatedness = Counter(questions[i]["relatedness"] for i in finals)
    return {
        "n": n,
        "with_ev": with_ev,
        "zero_ev": zero_ev,
        "clar_iters": clar_iters,
        "tool_fail": tool_fail,
        "tool_ok": tool_ok,
        "relatedness": relatedness,
    }


def main():
    s = styles()
    rows1, f1, c1, q1 = load_run(RUN1)
    rows2, f2, c2, q2 = load_run(RUN2)
    st1 = summary_stats(f1, c1, q1)
    st2 = summary_stats(f2, c2, q2)

    doc = SimpleDocTemplate(
        str(OUT),
        pagesize=letter,
        leftMargin=0.75 * inch,
        rightMargin=0.75 * inch,
        topMargin=0.7 * inch,
        bottomMargin=0.75 * inch,
        title="Ontix IQ Grind Briefing — Run 1 & Run 2",
        author="Ontix IQ Question Grinder",
    )
    story = []

    # ---- Cover / summary ----
    story.append(Paragraph("ONTIX IQ · EXECUTIVE INTELLIGENCE", s["cover_kicker"]))
    story.append(Paragraph("Question Grind Briefing", s["cover_title"]))
    story.append(
        Paragraph(
            "Two 50-question stress runs against live Asana, AWS, and Notion connections. "
            "Run 1 pummeled typical CEO recurring questions. Run 2 deliberately targeted "
            "metrics that require data sources not yet connected—to surface the next sprint’s integrations.",
            s["cover_sub"],
        )
    )

    story.append(Paragraph("Run 1 — Recurring CEO questions", s["h2"]))
    story.append(
        Paragraph(
            "Seeded from Art Bradshaw’s recurring questions and executive examples in ORGANIZATION.md. "
            "Questions spanned exact copies through closely related variants, with a few stretch and bonkers prompts. "
            "Follow-ups were answered from real DEPARTURE operating context.",
            s["body"],
        )
    )
    story.append(Paragraph(f"• <b>{st1['n']}/50</b> final answers · <b>0</b> hard errors · <b>{st1['tool_fail']}</b> tool failures", s["bullet"]))
    story.append(Paragraph(f"• <b>{st1['with_ev']}</b> answers cited evidence · <b>{st1['zero_ev']}</b> with none", s["bullet"]))
    story.append(Paragraph(f"• <b>{st1['clar_iters']}</b> iterations needed clarification before answering", s["bullet"]))
    story.append(Paragraph(f"• <b>{st1['tool_ok']}</b> successful tool calls across final answers", s["bullet"]))
    story.append(
        Paragraph(
            "• Strongest domains: AWS spend/inventory, Notion subscriptions, Asana task analytics, PM assignment, period comparisons",
            s["bullet"],
        )
    )
    story.append(
        Paragraph(
            "• Standing ambiguity: <b>projects vs tasks</b> — rankings and averages diverge depending on metric",
            s["bullet"],
        )
    )

    story.append(Paragraph("Run 2 — Data-gap CEO questions", s["h2"]))
    story.append(
        Paragraph(
            "Fifty CEO-level questions aimed at dollars, margins, AR, CRM pipeline, utilization, contracts, "
            "Slack/email, GitHub, Dropbox, hiring cost, and web analytics—systems called out as future integrations "
            "or absent from the current stack. Follow-ups insisted on the real metric instead of Asana proxies.",
            s["body"],
        )
    )
    story.append(Paragraph(f"• <b>{st2['n']}/50</b> final answers · <b>~47</b> explicitly named a connectivity gap", s["bullet"]))
    story.append(Paragraph(f"• <b>{st2['zero_ev']}</b> zero-evidence finals (clean “can’t answer without X”) · <b>{st2['with_ev']}</b> partial hits", s["bullet"]))
    story.append(Paragraph(f"• <b>{st2['clar_iters']}</b> iterations clarified before answering", s["bullet"]))
    story.append(
        Paragraph(
            "• Sprint priority gaps: <b>financial/billing/AR</b>, <b>CRM/proposals</b>, <b>time tracking</b>, then Dropbox / Slack / GitHub",
            s["bullet"],
        )
    )
    story.append(
        Paragraph(
            "• Partial Notion hits: historical billable rates, insurance/lease crumbs, partner-document pointers—useful but not High Confidence money answers",
            s["bullet"],
        )
    )

    story.append(Spacer(1, 0.2 * inch))
    story.append(
        Paragraph(
            "Pages that follow: <b>12 examples from Run 1</b>, then <b>12 from Run 2</b>. "
            "Each page is one Q&amp;A chosen for a surprisingly strong signal, a metric tension, or a notable source gap.",
            s["body"],
        )
    )
    story.append(PageBreak())

    # ---- Run 1 examples ----
    run1_examples = [
        {
            "id": 1,
            "signal": "Strong signal",
            "why": "Clean client ranking from Asana task analytics—High Confidence operational answer once “projects” was clarified as tasks created.",
        },
        {
            "id": 2,
            "signal": "Metric tension",
            "why": "Same season, different metric: counting Asana projects created (not tasks) flips the “biggest client” story to August Bioservices—shows why projects vs tasks must be explicit.",
        },
        {
            "id": 5,
            "signal": "Strong signal",
            "why": "Precise YTD AWS dollars with amortized Cost Explorer evidence—prototype strength on connected infrastructure spend.",
        },
        {
            "id": 7,
            "signal": "Strong signal",
            "why": "Honest contract-break answer: verifies $0 Reserved Instance commitment while refusing to invent termination fees outside connected APIs.",
        },
        {
            "id": 10,
            "signal": "Strong signal",
            "why": "Notion subscription inventory produced a concrete 2026 spend figure and called out the missing Figma line—good multi-source discipline.",
        },
        {
            "id": 16,
            "signal": "Strong signal",
            "why": "Service-growth comparison with historical rates and an explicit confidence note—forecast-style reasoning without fabricating dollars.",
        },
        {
            "id": 18,
            "signal": "Source gap",
            "why": "Classic CEO wording (“projects per month”) meets a structural limit: Asana analytics counted tasks, and IQ refused a fake conversion.",
        },
        {
            "id": 23,
            "signal": "Strong signal",
            "why": "Exact PM workload comparison (Leslie 13 vs Kelly 5)—the kind of recurring staffing question the current stack already supports.",
        },
        {
            "id": 31,
            "signal": "Source gap",
            "why": "Profitability question fell back to task-mix proxy—preview of Run 2’s thesis that financial systems are required for High Confidence margins.",
        },
        {
            "id": 33,
            "signal": "Strong signal",
            "why": "AWS inventory read: fleet is mostly t4g.micro/small; no dramatic oversizing—actionable infra hygiene without guesswork.",
        },
        {
            "id": 45,
            "signal": "Strong signal",
            "why": "Stretch staffing question still returned a concrete hire recommendation grounded in developer workload evidence and stated assumptions.",
        },
        {
            "id": 47,
            "signal": "Strong signal",
            "why": "Off-the-wall prompt answered with real July EC2 cost leadership—playful framing, factual grounding.",
        },
    ]

    for idx, ex in enumerate(run1_examples, start=1):
        i = ex["id"]
        q = q1[i]
        a = f1[i]
        example_page(
            story,
            run_label="Run 1 · Recurring CEO questions",
            example_num=idx,
            total=len(run1_examples),
            iteration=i,
            question=q["content"],
            answer=a["content"],
            relatedness=q["relatedness"],
            signal=ex["signal"],
            why=ex["why"],
            evidence=int(a["evidence_count"]),
            tools_ok=int(a["tool_successes"]),
            tools_fail=int(a["tool_failures"]),
            clarifs=c1.get(i, 0),
            duration_ms=int(a["duration_ms"]),
        )

    # ---- Run 2 examples ----
    run2_examples = [
        {
            "id": 1,
            "signal": "Source gap",
            "why": "Direct revenue ranking—IQ refuses Asana volume as a substitute and names billing/accounting as the missing source.",
        },
        {
            "id": 10,
            "signal": "Source gap",
            "why": "AR aging is a weekly CEO cash question; answer correctly treats missing ledger as unavailable, not zero.",
        },
        {
            "id": 13,
            "signal": "Strong signal",
            "why": "Surprising partial hit: Notion still held historical billable rates by role—useful planning crumb inside a broader financial gap.",
        },
        {
            "id": 14,
            "signal": "Source gap",
            "why": "Utilization by person needs time tracking/PSA—Asana assignments alone are called out as insufficient.",
        },
        {
            "id": 22,
            "signal": "Source gap",
            "why": "Open pipeline by stage/close date maps cleanly to a CRM integration for the next sprint.",
        },
        {
            "id": 23,
            "signal": "Source gap",
            "why": "After clarification loops, IQ stops and states no CRM is connected—no invented opportunity values.",
        },
        {
            "id": 27,
            "signal": "Metric tension",
            "why": "Hiring-cost question assembled a planning floor from partial evidence while admitting fully loaded San Diego cost needs payroll systems.",
        },
        {
            "id": 32,
            "signal": "Metric tension",
            "why": "37 evidence items searched and still no verified MSA expirations—document store connectivity ≠ contract intelligence.",
        },
        {
            "id": 34,
            "signal": "Source gap",
            "why": "Insurance Documents page found in Notion, but premiums not in retrieved content—shows need for deeper doc/attachment access.",
        },
        {
            "id": 40,
            "signal": "Source gap",
            "why": "Client response-time KPI explicitly blocked on Slack/email—future integrations already listed in ORGANIZATION.md.",
        },
        {
            "id": 42,
            "signal": "Source gap",
            "why": "Production hotfix ranking needs GitHub telemetry; answer names the future integration without fabricating deploy history.",
        },
        {
            "id": 44,
            "signal": "Strong signal",
            "why": "Brand-guideline locations partially recoverable via Asana links + Notion Partner Documents—points at Dropbox as the authoritative file layer.",
        },
    ]

    for idx, ex in enumerate(run2_examples, start=1):
        i = ex["id"]
        q = q2[i]
        a = f2[i]
        example_page(
            story,
            run_label="Run 2 · Data-gap CEO questions",
            example_num=idx,
            total=len(run2_examples),
            iteration=i,
            question=q["content"],
            answer=a["content"],
            relatedness=q["relatedness"],
            signal=ex["signal"],
            why=ex["why"],
            evidence=int(a["evidence_count"]),
            tools_ok=int(a["tool_successes"]),
            tools_fail=int(a["tool_failures"]),
            clarifs=c2.get(i, 0),
            duration_ms=int(a["duration_ms"]) if a.get("duration_ms") else None,
            missing_source=q.get("missing_source") or None,
        )

    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
