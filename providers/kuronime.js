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
 * Resolves a TMDB ID to the original or Romanized title of the anime
 * Uses native fetch() for sandbox engine safety
 */
function fetchMediaTitle(tmdbId, mediaType) {
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
      return title.replace(/[:\-–—()]/g, ' ').replace(/\s+/g, ' ').trim();
    })
    .catch(error => {
      console.error(`[Kuronime] TMDB title resolution failed for ID ${tmdbId}:`, error.message);
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

  return fetchMediaTitle(tmdbId, mediaType)
    .then(title => {
      if (!title) {
        console.log("[Kuronime] Could not resolve title. Search aborted.");
        return [];
      }

      const searchTerms = getAlternativeTitles(title, season);
      const primarySearchQuery = searchTerms[0]; // Start with the best seasonal term
      console.log(`[Kuronime] Resolved title: "${title}". Searching for: "${primarySearchQuery}"`);

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

        // Parse WordPress search results (Muvipro theme uses h4 elements for titles)
        $('h4 a').each((index, element) => {
          const resultTitle = $(element).text().trim().toLowerCase();
          const href = $(element).attr('href');

          // Match the title dynamically against our search candidates
          const isMatch = searchTerms.some(term => {
            const t = term.toLowerCase();
            return resultTitle.includes(t) || t.includes(resultTitle);
          });

          if (isMatch && href) {
            animeUrl = href;
            return false; // Break cheerio loop
          }
        });

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

              // Muvipro structures episode lists inside class wrappers
              $main('.muvipro-episode-list a, .episode-list a, .eps-list a, a').each((index, element) => {
                const linkText = $main(element).text().trim().toLowerCase();
                const href = $main(element).attr('href');

                // Regex matches "Episode 5", "Eps 5", "Ep 5", "Epsode 5" or standalone number "5"
                const epsRegex = new RegExp(`\\b(eps|ep|episode|epsode)\\b\\s*${episode}\\b|\\b${episode}\\b`);
                if (epsRegex.test(linkText) && href && href.includes('episode')) {
                  targetEpisodeUrl = href;
                  return false; // Found exact match, break loop
                }
              });

              // Fallback to manual slug structure matching if page parsing misses it
              if (!targetEpisodeUrl) {
                const slug = animeUrl.replace(/\/$/, "").split("/").pop();
                targetEpisodeUrl = `${BASE_URL}/${slug}-episode-${episode}/`;
                console.log(`[Kuronime] Episode list match failed. Standardizing slug path: ${targetEpisodeUrl}`);
              } else {
                console.log(`[Kuronime] Discovered exact episode URL: ${targetEpisodeUrl}`);
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
  return axios.get(tmdbUrl)
    .then(response => {
      // Prioritize Japanese original name for anime search, fallback to standard titles
      const title = response.data.original_name || 
                    response.data.original_title || 
                    response.data.name || 
                    response.data.title;
      
      if (!title) throw new Error("Metadata empty on TMDB");
      
      // Clean up special characters that WordPress search struggles with
      return title.replace(/[:\-–—()]/g, ' ').replace(/\s+/g, ' ').trim();
    })
    .catch(error => {
      console.error(`[Kuronime] TMDB title resolution failed for ID ${tmdbId}:`, error.message);
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

  return fetchMediaTitle(tmdbId, mediaType)
    .then(title => {
      if (!title) {
        console.log("[Kuronime] Could not resolve title. Search aborted.");
        return [];
      }

      const searchTerms = getAlternativeTitles(title, season);
      const primarySearchQuery = searchTerms[0]; // Start with the best seasonal term

      console.log(`[Kuronime] resolved title: "${title}". Searching for: "${primarySearchQuery}"`);
      const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(primarySearchQuery)}`;

      return axios.get(searchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        }
      })
      .then(response => {
        const $ = cheerio.load(response.data);
        let animeUrl = null;

        // Parse WordPress search results (Muvipro theme uses h4 elements for titles)
        $('h4 a').each((index, element) => {
          const resultTitle = $(element).text().trim().toLowerCase();
          const href = $(element).attr('href');
          
          // Match the title dynamically against our search candidates
          const isMatch = searchTerms.some(term => {
            const t = term.toLowerCase();
            return resultTitle.includes(t) || t.includes(resultTitle);
          });

          if (isMatch && href) {
            animeUrl = href;
            return false; // Break cheerio loop
          }
        });

        if (!animeUrl) {
          console.log(`[Kuronime] No matching anime page found for search terms.`);
          return [];
        }

        console.log(`[Kuronime] Matched main page URL: ${animeUrl}`);

        // If TV show, fetch the main page and dynamically scrape the episode list for the exact episode
        if (mediaType === "tv") {
          return axios.get(animeUrl)
            .then(mainPageResponse => {
              const $main = cheerio.load(mainPageResponse.data);
              let targetEpisodeUrl = null;

              // Muvipro structures episode lists inside class wrappers
              $main('.muvipro-episode-list a, .episode-list a, .eps-list a, a').each((index, element) => {
                const linkText = $main(element).text().trim().toLowerCase();
                const href = $main(element).attr('href');

                // Regex matches "Episode 5", "Eps 5", "Ep 5", "Epsode 5" or standalone number "5"
                const epsRegex = new RegExp(`\\b(eps|ep|episode|epsode)\\b\\s*${episode}\\b|\\b${episode}\\b`);
                if (epsRegex.test(linkText) && href && href.includes('episode')) {
                  targetEpisodeUrl = href;
                  return false; // Found exact match, break loop
                }
              });

              // Fallback to manual slug structure matching if page parsing misses it
              if (!targetEpisodeUrl) {
                const slug = animeUrl.replace(/\/$/, "").split("/").pop();
                targetEpisodeUrl = `${BASE_URL}/${slug}-episode-${episode}/`;
                console.log(`[Kuronime] Episode list match failed. Standardizing slug path: ${targetEpisodeUrl}`);
              } else {
                console.log(`[Kuronime] Discovered exact episode URL: ${targetEpisodeUrl}`);
              }

              return axios.get(targetEpisodeUrl);
            });
        }

        // Movies run directly on the detail page
        return axios.get(animeUrl);
      })
      .then(episodeResponse => {
        const $ = cheerio.load(episodeResponse.data);
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
