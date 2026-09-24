# S3: Firecrawl scoping for Classic Era

Spec: §12, §18.3 (S3). Issue: RED-332. Input to P7.1 (RED-333).

Question: do `site:` filters plus URL-prefix post-filtering return good
Classic Era results?

Answer: yes. The post-filter is required, because Firecrawl does not always
honor `site:`. After the filter, every question had an in-scope hit. A
snippet from the first five in-scope hits answered 13 of 15 questions and
partly answered the other 2. `site:wowhead.com/classic` returns more in-scope
hits than `site:wowhead.com`.

## Method

- Script: `spikes/s3/run.ts`. Questions: `spikes/s3/questions.json`. Summary
  of every call: `spikes/s3/results.json`. Raw responses were kept out of the
  repo.
- 15 questions, 3 for each RED-224 question type, set in Elwynn Forest,
  Durotar, and Westfall. Each query is written the way an agent would write
  it from game state: quest, NPC, item, and zone names. It is not the
  player's own wording.
- Scope: the `classic_era.search` prefixes in `kits/wow/manifest.json`,
  `https://www.wowhead.com/classic/` and `https://warcraft.wiki.gg/`.
- Firecrawl `POST /v2/search`, `limit: 10`, `sources: ["web"]`.
- Post-filter: the URL parses, is https, has no credentials or port, and its
  `href` starts with a prefix.
- Fetch: `POST /v2/scrape` of the first in-scope hit from the `prefix`
  variant, with `formats: ["markdown"]` and `onlyMainContent: true`.
- Grading: yes, partly, or no. It was checked against the Wowhead Classic
  and warcraft.wiki.gg pages that the searches returned.
  - Snippet grade: one of the first five in-scope hits answers the question
    from its title and snippet. That is what `search_game_info` returns.
  - Fetch grade: the fetched page answers it.

Variants:

| Variant | Request |
|---|---|
| `host` | `<query> (site:wowhead.com OR site:warcraft.wiki.gg)` |
| `prefix` | `<query> (site:wowhead.com/classic OR site:warcraft.wiki.gg)` |
| `include_domains` | `<query>` with `includeDomains: ["wowhead.com", "warcraft.wiki.gg"]` (the prototype's shape) |
| `prefix_classic` | `classic <query> (site:wowhead.com/classic OR site:warcraft.wiki.gg)` |

`host` and `prefix` ran on all 15 questions. `include_domains` and
`prefix_classic` ran on the 5 questions with the most off-site hits: obj-1,
obj-3, qst-1, qst-2, and drp-2.

## Results

### By variant

| Variant | Calls | Hits | In scope | Queries with off-site hits | Queries with ≤2 in scope | Median latency | Max latency |
|---|---|---|---|---|---|---|---|
| `host` | 15 | 150 | 60 (40%) | 5 | 4 | 735 ms | 3,084 ms |
| `prefix` | 15 | 146 | 95 (65%) | 7 | 2 | 761 ms | 1,368 ms |
| `include_domains` | 5 | 50 | 20 (40%), 5 of them unrelated | 0 | 1 | 16,801 ms | 20,886 ms |
| `prefix_classic` | 5 | 50 | 11 (22%) | 5 | 3 | 749 ms | 812 ms |

On the same 5 questions, `host` kept 12 hits and `prefix` kept 11.

### Hits dropped by the post-filter

| Category | `host` | `prefix` |
|---|---|---|
| Wowhead other flavors: `/tbc/`, `/wotlk/`, `/mop-classic/`, `/cata/`, `/forever/`, `/classic-ptr/` | 46 | 12 |
| Wowhead retail (no flavor path) | 24 | 9 |
| Wowhead `/forums/` | 2 | 0 |
| Other hosts: YouTube, Reddit, Instagram, Fandom wikis, classicdb.ch, Blizzard forums, others | 18 | 30 |
| Total | 90 | 51 |

In-scope hits of the `prefix` variant, by kind:

| Kind | Hits |
|---|---|
| Wowhead Classic entity pages (quest, NPC, item, spell) | 45 |
| warcraft.wiki.gg | 33 |
| Localized Wowhead Classic (`/classic/ru/`, `/classic/cn/`, `/classic/es/`, `/classic/de/`) | 8 |
| Wowhead Classic guides | 5 |
| Wowhead Classic news | 3 |
| Wowhead Classic forums | 1 |

### By question

In each "host / prefix" column, the first number is the `host` variant and
the second is `prefix`. "First in scope" is the rank of the first in-scope
hit among the 10 raw hits. The last two columns are the grades for the
`prefix` variant.

| ID | Type | In scope | First in scope | Off-site hits | Latency (ms) | Snippet answers | Fetch answers |
|---|---|---|---|---|---|---|---|
| npc-1 | NPC location | 8 / 10 | 1 / 1 | 0 / 0 | 715 / 589 | yes | yes |
| npc-2 | NPC location | 6 / 10 | 1 / 1 | 0 / 0 | 598 / 1,368 | yes | yes, at char 21,231 |
| npc-3 | NPC location | 5 / 10 | 1 / 1 | 0 / 0 | 547 / 734 | yes | partly: zone only |
| obj-1 | Object location | 1 / 1 | 2 / 2 | 5 / 5 | 672 / 772 | yes | yes |
| obj-2 | Object location | 2 / 4 | 2 / 2 | 3 / 5 | 735 / 761 | yes | yes |
| obj-3 | Object location | 1 / 1 | 1 / 1 | 6 / 7 | 481 / 748 | yes | yes |
| qst-1 | Quest step | 4 / 3 | 2 / 3 | 0 / 3 | 2,054 / 634 | partly | partly: NPC page, not the quest |
| qst-2 | Quest step | 3 / 3 | 3 / 4 | 1 / 4 | 609 / 821 | yes | yes |
| qst-3 | Quest step | 5 / 5 | 1 / 1 | 3 / 2 | 1,234 / 1,127 | partly | yes |
| drp-1 | Drop source | 3 / 6 | 1 / 1 | 0 / 0 | 515 / 598 | yes | yes |
| drp-2 | Drop source | 3 / 3 | 1 / 1 | 0 / 4 | 875 / 733 | yes | partly: names the item, not the mob |
| drp-3 | Drop source | 4 / 10 | 1 / 1 | 0 / 0 | 813 / 655 | yes | yes |
| mec-1 | Class fact | 7 / 10 | 1 / 1 | 0 / 0 | 1,101 / 855 | yes | yes |
| mec-2 | Class fact | 6 / 10 | 1 / 1 | 0 / 0 | 1,798 / 786 | yes | yes |
| mec-3 | Mechanic | 2 / 9 | 1 / 1 | 0 / 0 | 3,084 / 872 | yes | yes, but the cost shows as "20" with no unit |

The `host` variant gets the same snippet grades: 13 yes and 2 partly.

## Findings

1. Firecrawl does not enforce `site:`, so the post-filter is required.
   - With `prefix`, 7 of 15 queries returned other hosts. With `host`, 5
     of 15 did.
   - When Firecrawl ignores `site:`, it ignores it for the whole result
     set. The leaky queries returned similar lists under both shapes.
   - 6 of the 7 leaky `prefix` queries contained question phrasing such as
     "where to find", "next step", or "what to do next". 1 of the 8
     queries with no leak did ("what level"). This spike did not test
     whether keyword-only queries leak less often.
2. `site:wowhead.com/classic` works as a path filter when Firecrawl honors
   `site:`.
   - On the 8 queries with no leak, 75 of 76 hits were in scope. `host`
     kept 2 to 8 of 10 on the same queries.
   - `host` fills the results with the same page in other flavors: 70 of
     its 150 hits were Wowhead retail or other-flavor pages.
3. Without the post-filter, the agent would see a non-Era page first on 4 of
   15 questions:
   - obj-1: a `/forever/` page
   - obj-2: YouTube
   - qst-1 and qst-2: retail pages

   After the filter, every question had at least one in-scope hit. The
   first in-scope hit was correct for Era each time.
4. Quest-step questions are the weakest.
   - Wowhead quest chains reuse one name. "The Defias Brotherhood" has at
     least five parts.
   - The snippets for those pages are table markup.
   - A fetch of the quest page answers qst-3.
   - For qst-1, the Wowhead Classic quest page was the second in-scope hit,
     so the fetch took the NPC's wiki page instead. The quest page's
     objective states the step.
5. Scope misses: the filter dropped hits that held an answer.
   - For qst-1 and qst-3, the only snippets that stated the next step came
     from Wowhead retail and TBC Classic pages.
   - The filter also dropped Classic sources outside the scope: classicdb.ch
     and the Fandom wowwiki-archive and classic-wow-archive wikis.
   - In each case an in-scope page held the answer too.
   - No `classic.wowhead.com` URL and no Wowhead URL without `www.`
     appeared, so no prefix is missing.
6. Some in-scope hits contain content that is not Classic Era. The prefix
   filter cannot catch these:
   - **The wiki covers every version.** warcraft.wiki.gg's Riding page
     states current retail rules: "Apprentice Riding has been removed.
     Riding now requires level 10". It was the second in-scope hit for
     mec-3. NPC pages have retail sections ("This section concerns content
     related to Legion"), but their first sentence was correct for Era in
     every case seen.
   - **Old news and forum posts sit under `/classic/`.** Wowhead
     `/classic/es/news/holy-crap-mount-levels-changed-101827` describes a
     later change: riding at level 20 for 4 gold. A `/classic/de/forums/`
     thread covers the same change. Both were in-scope hits for mec-3.
   - **`/classic/` carries Season of Discovery data too.** The Goretusk Liver
     drop table is headed "Season of Discovery - Phase 8".
   - **Localized pages pass the filter.** They were 8 of the `prefix`
     variant's 95 in-scope hits and repeat English pages with translated
     names. News and forum pages were another 4.
   - **Comments on `/classic/` pages sometimes describe retail.** One
     example: "Retail the crates are in the midfield".

   None of these was the first in-scope hit for any question. mec-3 is the
   only question with non-Era content in its first five in-scope hits.
7. `includeDomains` enforces hosts but not paths.
   - It returned no off-site hits on 5 questions.
   - Wowhead retail and other-flavor pages still took 30 of its 50 hits.
   - It took 4.3 to 20.9 seconds. The `site:` variants took 0.5 to 2.1
     seconds on the same questions.
   - When few pages match, it adds unrelated pages. For obj-3 it returned
     5 wiki pages on topics such as Hex Lord Malacrass and the Void.
8. Adding "classic" to the query kept the same in-scope count (11 on 5
   questions). It moved the first in-scope hit up on 3 of 5 questions.
9. Fetching works, but some pages exceed the proposed 20k truncation
   (§10.3).
   - Each scrape cost 1 credit and took 1.2 to 2.2 seconds.
   - Every final URL (`metadata.url`) stayed in scope.
   - Markdown sizes ran from 4.0k to 75.4k characters. 4 of 15 pages were
     over 20k.
   - For npc-2 the answer is at character 21,231, past the truncation.
   - Wowhead markdown is mostly image and link markup. For npc-2, removing
     images moves the answer to 18.0k. Removing images and link targets
     moves it to 7.6k. With both removed, every answer found on the 15
     pages starts before character 7,700.
   - Wowhead NPC pages give the zone only: the map pins are not in the
     markdown (npc-3). The coin icon is an image, so a cost of 20 gold
     shows as "20" (mec-3).
10. The key's plan allows about 10 requests a minute. The 11th request in a
    minute returned 429 "Rate limit exceeded" and billed nothing. The plan
    has 1,000 credits per billing period.
11. Wowhead has a `/forever/` section, labeled "Always up to date with the
    latest patch (1.60.1)". It appeared 12 times in these results. It is a
    candidate for Forever's search scope (§19.2). This spike did not
    evaluate it.

## Cost

| Call | Credits | Latency |
|---|---|---|
| Search, 1 to 10 hits | 2 | median 0.76 s with `site:`; median 16.8 s with `includeDomains` |
| Scrape, markdown | 1 | 1.2 to 2.2 s |
| Search plus one fetch | 3 | about 2 to 3 s |

Spike total: 40 billed searches (80 credits) and 15 scrapes (15 credits),
95 credits in all. 5 rate-limited calls billed nothing. The team balance
went from 829 to 734.

At these prices, 1,000 credits cover 500 uncached searches, or about 333
answers that use a search and a fetch.

## Recommendation for P7.1 (RED-333)

1. **Query shape.** Send the agent's query, then
   `(site:wowhead.com/classic OR site:warcraft.wiki.gg)`. Build each `site:`
   term from a manifest prefix: the host without `www.`, then the path
   without its trailing slash. Do not add words to the query. Do not use
   `includeDomains`.
2. **Post-filter.** Filter every hit as §12 says. Parse the URL, and require
   https, no credentials, no port, and an `href` that starts with a prefix.
   `site:` only affects ranking. The filter is the scope guarantee.
3. **Limit.** Ask Firecrawl for 10 hits: 1 to 10 hits cost the same 2
   credits. Return up to 5 in-scope hits. With the `prefix` shape, the
   median in-scope count was 6, and 2 of 15 queries kept only 1.
4. **Fetch.** Keep `fetch_game_page`.
   - Use `POST /v2/scrape` with `formats: ["markdown"]` and
     `onlyMainContent: true`.
   - Check `metadata.url` against the scope.
   - Remove images and link targets before the 20k truncation, and keep
     the link text. The agent then looks up a linked page by name instead
     of following its URL.
   - Do not set `scrapeOptions` on search. It scrapes every hit at 1 credit
     each.
5. **Cache.**
   - **Search key:** `(kit, flavor, scope_hash, normalized_query)`, as §12
     says. `normalized_query` is the agent's query before the `site:`
     suffix, in NFKC, lower case, with single spaces, and trimmed.
     `scope_hash` hashes the prefix list. Also put the query template and
     the limit into the `scope_hash` input, so that a change to the query
     shape invalidates old entries too.
   - **What to store:** the post-filtered hits, not the raw hits.
   - **Page key:** the URL without its fragment. Wowhead links carry
     fragments such as `#comments` and `#screenshots`.
   - **Empty results:** cache them for a shorter time than the 7-day TTL.
     The prototype used 1 hour.
6. **Rate limit.** Return Firecrawl's 429 to the agent as
   `search_unavailable` (§10.5). Production needs a plan with a higher
   per-minute limit than this key has.
7. **Manifest.** Make no change to `classic_era.search`. The two prefixes
   cover every in-scope answer found, and no other Wowhead Classic URL form
   appeared.
8. **Open for the spec owner.** The manifest cannot exclude sub-paths under
   a prefix. Localized Wowhead pages, `/classic/news/`, and
   `/classic/forums/` pass the filter. They were 12 of the `prefix`
   variant's 95 in-scope hits, and none was the first in-scope hit. There
   are two options:
   - accept them in v1
   - add an exclusion list to `flavors.<key>.search`, which is an SDK schema
     change (§6.1)

   This data supports accepting them in v1.
