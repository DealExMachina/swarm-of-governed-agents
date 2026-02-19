# Seed documents for the swarm context WAL

These files are loaded in filename order by `npm run seed:all` to give the facts agent realistic business context.

| File | Content |
|------|---------|
| 01-announcement.txt | Acme Corp Q3 earnings release: revenue, CEO/CFO statements, hiring goal (20 engineers). |
| 02-strategy-memo.txt | Internal strategy memo: priorities, assumptions, risks (talent, SOC 2, narrative contradiction), goals. |
| 03-meeting-notes.txt | Product & engineering sync: Nexus delay, hiring revised to 15 realistic / 20 stretch, SOC 2 date, alignment of messaging. |
| 04-product-brief.txt | Nexus product brief: claims, risks, assumptions, goals, owner. |
| 05-follow-up.txt | Board briefing excerpt: revised hiring target (15 vs 20), contradiction resolution, risks. |

Together they provide entities (Acme, CEO, CFO, Nexus, etc.), claims, risks, assumptions, goals, and an explicit contradiction (20 vs 15 hires) so the facts worker can extract structured facts and the drift/planner pipeline can trigger governance rules.
