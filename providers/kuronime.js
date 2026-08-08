// providers/kuronime.js
const cheerio = require('cheerio-without-node-native');

const BASE_URL = "https://154.203.162.226"; // Active Kuronime IP/Domain
const TMDB_API_KEY = "844132b4db1b13101217e57c1d1a8123"; // Fallback TMDB key for title resolution

/**
 * Converts a number into Roman numerals (useful for anime seasons e.g. Youjo Senki II)
 */
function getRomanNumeral(num) {
  const roman = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX"];
  return roman[num] || "";
}

/**
 * Resolves a Kitsu ID to its titles and attributes
 */
function fetchKitsuMetadata(kitsuId) {
  const kitsuUrl = `https://kitsu.io/api/edge/anime/${kitsuId}`;
  return fetch(kitsuUrl)
    .then(res => res.ok ? res.json() : null)
    .then(data => {
      const anime = data && data.data && data.data.attributes;
      if (!anime) return null;

      const titles = [];
      if (anime.canonicalTitle) titles.push(anime.canonicalTitle);
      if (anime.titles) {
        if (anime.titles.en) titles.push(anime.titles.en);
        if (anime.titles.en_jp) titles.push(anime.titles.en_jp);
      }
      return { titles, isAnime: true };
    })
    .catch(() => null);
}

/**
 * Resolves TMDB TV season details (like Season Name)
 */
function fetchTMDBSeasonName(tmdbId, season) {
  const seasonUrl = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${season}?api_key=${TMDB_API_KEY}&language=en-US`;
  return fetch(seasonUrl)
    .then(res => res.ok ? res.json() : null)
    .then(data => data ? data.name : null)
    .catch(() => null);
}

/**
 * Fetches TMDB Main TV show details & Alternative titles
 */
function fetchTMDBMetadata(tmdbId, mediaType, season) {
  const type = mediaType === "tv" ? "tv" : "movie";
  const mainUrl = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`;
  const altUrl = `https://api.themoviedb.org/3/${type}/${tmdbId}/alternative_titles?api_key=${TMDB_API_KEY}`;

  return Promise.all([
    fetch(mainUrl).then(res => res.ok ? res.json() : null),
    fetch(altUrl).then(res => res.ok ? res.json() : null)
  ]).then(([mainData, altData]) => {
    if (!mainData) return null;

    const titles = [];
    const mainTitle = mainData.name || mainData.title || mainData.original_name || mainData.original_title;
    if (mainTitle) titles.push(mainTitle);
    if (mainData.original_name) titles.push(mainData.original_name);
    if (mainData.original_title) titles.push(mainData.original_title);

    if (altData && altData.results) {
      altData.results.forEach(item => {
        if (item.title) titles.push(item.title);
      });
    }

    // If it is a TV show and season > 1, let's fetch the season name to solve split season issues
    if (mediaType === "tv" && season > 1) {
      return fetchTMDBSeasonName(tmdbId, season)
        .then(seasonName => {
          return { mainTitle, titles, seasonName };
        });
    }

    return { mainTitle, titles, seasonName: null };
  });
}

/**
 * Generates highly targeted search queries for Kuronime using our metadata
 */
function generateSearchQueries(meta, season) {
  const queries = [];
  const main = meta.mainTitle;

  if (season > 1) {
    const roman = getRomanNumeral(season);
    
    // 1. If we have a specific season name (e.g., "Thousand-Year Blood War")
    if (meta.seasonName && meta.seasonName !== `Season ${season}`) {
      queries.push(`${main} ${meta.seasonName}`);
      queries.push(meta.seasonName); // Sometimes the site lists it directly as the season subtitle
    }

    // 2. Standard seasonal naming conventions
    queries.push(`${main} Season ${season}`);
    queries.push(`${main} ${roman}`);
    queries.push(`${main} S${season}`);
  }

  // 3. Fallbacks to alt titles
  meta.titles.forEach(t => {
    if (season > 1) {
      queries.push(`${t} Season ${season}`);
      queries.push(`${t} ${getRomanNumeral(season)}`);
    } else {
      queries.push(t);
    }
  });

  // Unique entries only
  return Array.from(new Set(queries)).filter(q => q.trim().length > 0);
}

/**
 * Scores how well a search result matches our expected anime metadata
 */
function scoreSearchResult(resultTitle, meta, season) {
  const title = resultTitle.toLowerCase();
  const mainTitleLower = meta.mainTitle.toLowerCase();
  let score = 0;

  // Exact or contains match on the main title
  if (title.includes(mainTitleLower)) {
    score += 10;
  }

  if (season > 1) {
    const roman = getRomanNumeral(season).toLowerCase();
    const seasonStr = `season ${season}`;
    const sStr = `s${season}`;

    // Specific Season subtitle match (e.g. "sennen kessen" or "thousand-year")
    if (meta.seasonName) {
      const seasonNameLower = meta.seasonName.toLowerCase();
      if (title.includes(seasonNameLower)) score += 30;
      // Partial keyword matches (e.g. "kessen" or "blood war")
      const keywords = seasonNameLower.split(' ').filter(w => w.length > 3);
      keywords.forEach(kw => {
        if (title.includes(kw)) score += 10;
      });
    }

    if (title.includes(seasonStr)) score += 25;
    if (title.includes(` ${roman}`) || title.endsWith(` ${roman}`)) score += 25;
    if (title.includes(sStr)) score += 20;

    // Check if the result has other season numbers to avoid matching the wrong season
    for (let i = 1; i <= 10; i++) {
      if (i !== season) {
        const otherRoman = ` ${getRomanNumeral(i).toLowerCase()}`;
        if (title.includes(`season ${i}`) || (otherRoman.trim().length > 0 && title.includes(otherRoman))) {
          score -= 40; // Heavy penalty for matching the wrong season
        }
      }
    }
  } else {
    // For Season 1, penalize multi-season sequels
    const multiSeasonKeywords = ["season 2", "season 3", "season 4", " ii", " iii", " iv"];
    multiSeasonKeywords.forEach(kw => {
      if (title.includes(kw)) score -= 30;
    });
  }

  return score;
}

/**
 * Main Nuvio Provider function
 */
function getStreams(id, mediaType, season, episode) {
  console.log(`[Kuronime] Starting resolution for ID: ${id} | Season: ${season} | Episode: ${episode}`);

  let isKitsu = false;
  let kitsuId = null;
  let numericId = id;

  if (typeof id === 'string' && id.startsWith('kitsu:')) {
    isKitsu = true;
    kitsuId = id.split(':')[1];
  }

  const metadataPromise = isKitsu 
    ? fetchKitsuMetadata(kitsuId)
    : fetchTMDBMetadata(numericId, mediaType, season);

  return metadataPromise
    .then(meta => {
      if (!meta) {
        console.log("[Kuronime] Metadata could not be fetched.");
        return [];
      }

      // If Kitsu resolved but has no mainTitle, synthesize one
      if (!meta.mainTitle && meta.titles && meta.titles.length > 0) {
        meta.mainTitle = meta.titles[0];
      }

      console.log(`[Kuronime] Mapped Title: "${meta.mainTitle}" | Season Name: "${meta.seasonName || 'N/A'}"`);

      const searchQueries = generateSearchQueries(meta, season);
      console.log(`[Kuronime] Generated Search Queries:`, searchQueries);

      // Execute search queries in parallel to get the best matching page quickly
      const searchPromises = searchQueries.slice(0, 3).map(query => {
        const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
        return fetch(searchUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
        })
        .then(res => res.ok ? res.text() : "")
        .then(html => {
          if (!html) return [];
          const $ = cheerio.load(html);
          const results = [];

          $('h4 a').each((i, el) => {
            const title = $(el).text().trim();
            const href = $(el).attr('href');
            if (title && href) {
              results.push({ title, href });
            }
          });
          return results;
        })
        .catch(() => []);
      });

      return Promise.all(searchPromises)
        .then(allResults => {
          // Flatten results
          const mergedResults = [].concat(...allResults);
          if (mergedResults.length === 0) {
            console.log("[Kuronime] No search results returned from site.");
            return [];
          }

          // Score and rank search results
          let bestPage = null;
          let highestScore = -999;

          mergedResults.forEach(item => {
            const score = scoreSearchResult(item.title, meta, season);
            console.log(`[Kuronime] Candidate: "${item.title}" | Score: ${score}`);
            if (score > highestScore && score > 0) {
              highestScore = score;
              bestPage = item;
            }
          });

          if (!bestPage) {
            console.log("[Kuronime] No candidates passed the matching threshold.");
            return [];
          }

          console.log(`[Kuronime] Best Match: "${bestPage.title}" (${bestPage.href}) with score ${highestScore}`);

          // Determine if the matched page is a separate split season
          const matchedTitleLower = bestPage.title.toLowerCase();
          const isSplitSeason = season > 1 && (
            matchedTitleLower.includes("season") || 
            matchedTitleLower.includes(` ${getRomanNumeral(season).toLowerCase()}`) ||
            (meta.seasonName && matchedTitleLower.includes(meta.seasonName.toLowerCase()))
          );

          // If it is a split season, episode numbering on the page starts back at 1!
          const targetEpisode = isSplitSeason ? episode : episode; 
          // Note: In Nuvio, the "episode" passed is already the relative episode number in that season.
          // Therefore, for split-season pages, we look for "episode" directly (e.g. Eps 1, Eps 2 etc.)

          console.log(`[Kuronime] Target Episode to search inside page: ${targetEpisode}`);

          if (mediaType === "tv") {
            return fetch(bestPage.href)
              .then(res => res.text())
              .then(mainHtml => {
                const $main = cheerio.load(mainHtml);
                let targetEpisodeUrl = null;

                // Look for links matching the episode number inside the list
                $main('.muvipro-episode-list a, .episode-list a, .eps-list a, a').each((index, element) => {
                  const linkText = $main(element).text().trim().toLowerCase();
                  const href = $main(element).attr('href');

                  // Look for words like "eps X", "ep X", "episode X", "epsode X" or exact number matches
                  const epsRegex = new RegExp(`\\b(eps|ep|episode|epsode)\\b\\s*${targetEpisode}\\b|\\b${targetEpisode}\\b`);
                  if (epsRegex.test(linkText) && href && href.includes('episode')) {
                    targetEpisodeUrl = href;
                    return false; // Break loop
                  }
                });

                // Fallback to manual slug structure matching if page parser misses it
                if (!targetEpisodeUrl) {
                  const slug = bestPage.href.replace(/\/$/, "").split("/").pop();
                  targetEpisodeUrl = `${BASE_URL}/${slug}-episode-${targetEpisode}/`;
                  console.log(`[Kuronime] Standard episode match failed. Trying fallback slug: ${targetEpisodeUrl}`);
                } else {
                  console.log(`[Kuronime] Found exact episode page: ${targetEpisodeUrl}`);
                }

                return fetch(targetEpisodeUrl).then(res => res.ok ? res.text() : "");
              });
          }

          // Movie matches can be parsed directly on the detail page
          return fetch(bestPage.href).then(res => res.ok ? res.text() : "");
        })
        .then(episodeHtml => {
          if (!episodeHtml) return [];
          const $ = cheerio.load(episodeHtml);
          const streams = [];

          // Scrape embedded players (iframe elements, select options, or source tags)
          $('iframe, select option, source').each((index, element) => {
            let src = $(element).attr('src') || $(element).attr('value') || $(element).attr('data-src');
            if (src && (src.includes('m3u8') || src.includes('embed') || src.includes('player') || src.includes('stream'))) {
              if (src.startsWith('//')) src = 'https:' + src;

              streams.push({
                name: "Kuronime",
                title: `Server ${index + 1} (Sub Indo)`,
                url: src,
                quality: "720p",
                headers: {
                  "Referer": BASE_URL,
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
                }
              });
            }
          });

          console.log(`[Kuronime] Playback streams resolved: ${streams.length} links discovered.`);
          return streams;
        });
    })
    .catch(error => {
      console.error('[Kuronime] Scraper pipeline error:', error.message);
      return [];
    });
}

module.exports = { getStreams };