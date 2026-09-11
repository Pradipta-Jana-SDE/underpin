# Discovery-path probe — empirical evidence (2026-08-27)

Three public production WordPress sites, read-only HEAD/GET on public endpoints.

| Probe | wordpress.org/news | techcrunch.com | variety.com |
|---|---|---|---|
| `Link: rel="https://api.w.org/"` | present | present | present |
| `/wp-json/` | 200 | 200 | 200 |
| `/?rest_route=/` | 200 | 200 | 200 |
| `/wp-json/wp/v2/pages` | 200 | 200 | 200 |
| `/wp-json/wp/v2/menus` | **401** | **401** | **401** |
| `/wp-sitemap.xml` (core) | 404 | 301 | 404 |
| `/sitemap_index.xml` (Yoast) | 404 | 302 | **200** |
| `/sitemap.xml` | **200** | **200** | 301 |
| `Sitemap:` in robots.txt | absent | present | present |

## Conclusions

1. **REST discovery via the `Link` header is reliable.** Present on all three; it also survives plain-permalink installs where `/wp-json/` 404s, because `?rest_route=` is advertised.
2. **`wp/v2/menus` is unusable unauthenticated — 401 on 3/3.** Navigation must be reconstructed from rendered DOM. This was a prediction; it is now measured.
3. **Sitemap location is genuinely unpredictable — the fixed-path assumption fails.** No single path won on more than two of three sites, and the "WP core default" `/wp-sitemap.xml` returned 200 on *none* of them. `robots.txt` is the only authoritative pointer, and it was absent on one site. The four-step discovery chain is not defensive over-engineering; it is the minimum that works.
