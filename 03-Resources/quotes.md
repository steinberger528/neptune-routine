---
name: quotes
description: Quote bank the morning brief draws from -- build-day picks one per day and never repeats within 30 days, tracked via day_plans.quote_used
type: reference
area: 03-Resources
created: 2026-09-11
---

# Quotes

One entry per quote. `id` is the value that lands in `day_plans.quote_used` -- keep an
id stable once it has been used anywhere, since renaming it breaks the 30-day no-repeat
check for any `day_plans` row that already references it. `id`s are kebab-case and
unique; never reuse one for a different quote.

`build-day` (`.claude/skills/build-day/SKILL.md`) walks the last 30 days of `day_plans`
via `jea.mjs day-plans get`, collects the `quote_used` ids it finds, and picks any entry
below whose id isn't in that set. If every entry has been used in the last 30 days, it
falls back to the least-recently-used one rather than skipping the quote.

Justin adds his own below the seed list -- same table, same id convention.

| id | quote | attribution | why it stuck |
|---|---|---|---|
| discipline-equals-freedom | "Discipline equals freedom." | Jocko Willink | |
| well-begun-is-half-done | "Well begun is half done." | Aristotle | |
| amateurs-sit-and-wait | "Amateurs sit and wait for inspiration, the rest of us just get up and go to work." | Stephen King | |
| you-do-not-rise-to-the-level | "You do not rise to the level of your goals. You fall to the level of your systems." | James Clear | |
| the-obstacle-is-the-way | "The impediment to action advances action. What stands in the way becomes the way." | Marcus Aurelius | |
| slow-is-smooth | "Slow is smooth, smooth is fast." | Navy SEAL maxim | |
| do-the-hard-things-first | "Eat a live frog first thing in the morning and nothing worse will happen to you the rest of the day." | attributed to Mark Twain | |
| plans-are-worthless | "Plans are worthless, but planning is everything." | Dwight D. Eisenhower | |
| how-we-spend-our-days | "How we spend our days is, of course, how we spend our lives." | Annie Dillard | |
| action-is-the-foundational-key | "Action is the foundational key to all success." | Pablo Picasso | |
