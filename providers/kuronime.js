// providers/kuronime.js
const cheerio = require('cheerio-without-node-native');

const BASE_URL = "https://154.203.162.226"; // Active Kuronime IP/Domain
const TMDB_API_KEY = "844132b4db1b13101217e57c1d1a8123"; // Fallback TMDB key for title resolution

/**
 * Programmatically generates alternative titles for seasonal search matching
 */
function getAlternativeTitles(baseTitle, season) {
  if (!season || season === 1) return [baseTitle];
  const romanNumerals = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
  const roman = romanNumerals[season] || "";
  
  return [
    `${baseTitle} ${roman}`,
    `${baseTitle} Season ${season}`,
    `${baseTitle} S${season}`,
    baseTitle
  ];
}

/**
 * Resolves a TMDB ID to the original or Romanized title of the anime and calculates absolute episode numbering.
 * Uses native fetch() for sandbox engine safety.
 */
function fetchMediaDetails(tmdbId, mediaType, requestedSeason, requestedEpisode) {
  const type = mediaType === "tv" ? "tv" : "movie";
  const tmdbUrl = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_API_KEY}`;

  return fetch(tmdbUrl)
    .then(response => {
      if (!response.ok) {
        throw new Error(`TMDB HTTP error! Status: ${response.status}`);
      }
      return response.json();
    })
    .then(data => {
      // Prioritize Japanese original name for anime search, fallback to standard titles
      const title = data.original_name || 
                    data.original_title || 
                    data.name || 
                    data.title;
                    
      if (!title) throw new Error("Metadata empty on TMDB");
      
      // Clean up special characters that WordPress search struggles with
      const cleanTitle = title.replace(/[:\-–—()]/g, ' ').replace(/\s+/g, ' ').trim();

      // Calculate absolute episode number for TV shows by summing episode counts of previous seasons
      let absoluteEpisode = requestedEpisode;
      if (type === "tv" && requestedSeason > 1 && Array.isArray(data.seasons)) {
        let sum = 0;
        for (const s of data.seasons) {
          if (s && s.season_number > 0 && s.season_number < requestedSeason) {
            sum += s.episode_count;
          }
        }
        if (sum > 0) {
          absoluteEpisode = sum + requestedEpisode;
          console.log(`[Kuronime] Calculated Absolute Episode: (Sum of seasons 1 to ${requestedSeason - 1}: ${sum}) + ${requestedEpisode} = ${absoluteEpisode}`);
        }
      }

      return {
        title: cleanTitle,
        absoluteEpisode: absoluteEpisode
      };
    })
    .catch(error => {
      console.error(`[Kuronime] TMDB media details resolution failed for ID ${tmdbId}:`, error.message);
      return null;
    });
}

/**
 * Main Nuvio Provider function
 * Uses clean Promise chains (.then) for 100% native compatibility with React Native + Hermes
 * without requiring any complex transpiler compilation steps.
 */
function getStreams(tmdbId, mediaType, season, episode) {
  console.log(`[Kuronime] Initializing search for TMDB ID: ${tmdbId} (${mediaType})`);

  return fetchMediaDetails(tmdbId, mediaType, season, episode)
    .then(details => {
      if (!details) {
        console.log("[Kuronime] Could not resolve media details. Search aborted.");
        return [];
      }

      const { title, absoluteEpisode } = details;
      const searchTerms = getAlternativeTitles(title, season);
      const primarySearchQuery = searchTerms[0]; // Start with the best seasonal term (Roman numeral or Season X)
      console.log(`[Kuronime] Resolved title: "${title}" | Absolute Ep: ${absoluteEpisode} | Searching for: "${primarySearchQuery}"`);

      const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(primarySearchQuery)}`;

      return fetch(searchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        }
      })
      .then(response => {
        if (!response.ok) {
          throw new Error(`Kuronime Search HTTP error! Status: ${response.status}`);
        }
        return response.text();
      })
      .then(html => {
        const $ = cheerio.load(html);
        let animeUrl = null;

        // Step 1: Prioritize matching seasonal search terms (anything except the base title)
        // This prevents selecting the main/Season 1 entry when a specific season entry is available
        $('h4 a').each((index, element) => {
          const resultTitle = $(element).text().trim().toLowerCase();
          const href = $(element).attr('href');

          const seasonalTerms = searchTerms.slice(0, -1);
          const isSeasonalMatch = seasonalTerms.some(term => {
            const t = term.toLowerCase();
            return resultTitle.includes(t) || t.includes(resultTitle);
          });

          if (isSeasonalMatch && href) {
            animeUrl = href;
            console.log(`[Kuronime] Priority match found for seasonal entry: "${resultTitle}"`);
            return false; // Break cheerio loop
          }
        });

        // Step 2: Fallback to matching the base title if no seasonal title matched
        if (!animeUrl) {
          $('h4 a').each((index, element) => {
            const resultTitle = $(element).text().trim().toLowerCase();
            const href = $(element).attr('href');

            const baseTerm = searchTerms[searchTerms.length - 1].toLowerCase();
            if (resultTitle.includes(baseTerm) || baseTerm.includes(resultTitle)) {
              animeUrl = href;
              console.log(`[Kuronime] Fallback match found for base entry: "${resultTitle}"`);
              return false; // Break cheerio loop
            }
          });
        }

        if (!animeUrl) {
          console.log(`[Kuronime] No matching anime page found for search terms.`);
          return [];
        }

        console.log(`[Kuronime] Matched main page URL: ${animeUrl}`);

        // If TV show, fetch the main page and dynamically scrape the episode list for the exact episode
        if (mediaType === "tv") {
          return fetch(animeUrl)
            .then(res => {
              if (!res.ok) throw new Error(`Anime Page HTTP error! Status: ${res.status}`);
              return res.text();
            })
            .then(mainPageHtml => {
              const $main = cheerio.load(mainPageHtml);
              let targetEpisodeUrl = null;

              // Step A: First search for the absolute/continuous episode number (important for long-runners like One Piece)
              $main('.muvipro-episode-list a, .episode-list a, .eps-list a, a').each((index, element) => {
                const linkText = $main(element).text().trim().toLowerCase();
                const href = $main(element).attr('href');
                if (!href || !href.includes('episode')) return;

                const absRegex = new RegExp(`\\b(eps|ep|episode|epsode)\\b\\s*${absoluteEpisode}\\b|\\b${absoluteEpisode}\\b`);
                if (absRegex.test(linkText)) {
                  targetEpisodeUrl = href;
                  console.log(`[Kuronime] Discovered exact absolute episode URL: ${targetEpisodeUrl}`);
                  return false; // Found exact match, break loop
                }
              });

              // Step B: If absolute matching failed, search for the relative episode number (important for separate seasonal pages)
              if (!targetEpisodeUrl) {
                $main('.muvipro-episode-list a, .episode-list a, .eps-list a, a').each((index, element) => {
                  const linkText = $main(element).text().trim().toLowerCase();
                  const href = $main(element).attr('href');
                  if (!href || !href.includes('episode')) return;

                  const relRegex = new RegExp(`\\b(eps|ep|episode|epsode)\\b\\s*${episode}\\b|\\b${episode}\\b`);
                  if (relRegex.test(linkText)) {
                    targetEpisodeUrl = href;
                    console.log(`[Kuronime] Discovered exact relative episode URL: ${targetEpisodeUrl}`);
                    return false; // Found exact match, break loop
                  }
                });
              }

              // Step C: Fallback to manual slug structure matching if page parsing missed it
              if (!targetEpisodeUrl) {
                const slug = animeUrl.replace(/\/$/, "").split("/").pop();
                targetEpisodeUrl = `${BASE_URL}/${slug}-episode-${episode}/`;
                console.log(`[Kuronime] Episode list match failed. Standardizing slug path: ${targetEpisodeUrl}`);
              }

              return fetch(targetEpisodeUrl).then(res => {
                if (!res.ok) throw new Error(`Episode Page HTTP error! Status: ${res.status}`);
                return res.text();
              });
            });
        }

        // Movies run directly on the detail page
        return fetch(animeUrl).then(res => {
          if (!res.ok) throw new Error(`Movie Page HTTP error! Status: ${res.status}`);
          return res.text();
        });
      })
      .then(episodeResponseHtml => {
        if (!episodeResponseHtml) return [];
        const $ = cheerio.load(episodeResponseHtml);
        const streams = [];

        // Scrape embedded players (iframe elements, video sources, or select options)
        $('iframe, select option, source').each((index, element) => {
          let src = $(element).attr('src') || $(element).attr('value') || $(element).attr('data-src');
          if (src && (src.includes('m3u8') || src.includes('embed') || src.includes('player') || src.includes('stream'))) {
            if (src.startsWith('//')) src = 'https:' + src;

            streams.push({
              name: "Kuronime",
              title: `Server ${index + 1} (Sub Indo)`,
              url: src,
              quality: "720p", // Standard HD container resolution
              headers: {
                "Referer": BASE_URL,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
              }
            });
          }
        });

        console.log(`[Kuronime] Stream resolution complete. Discovered ${streams.length} stream urls.`);
        return streams;
      });
    })
    .catch(error => {
      console.error('[Kuronime] Scraper pipeline encountered an error:', error.message);
      return [];
    });
}

module.exports = { getStreams };
