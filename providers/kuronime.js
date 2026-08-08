// providers/kuronime.js
const cheerio = require('cheerio-without-node-native');

const BASE_URL = "https://154.203.162.226"; // Active Kuronime IP/Domain
const TMDB_API_KEY = "844132b4db1b13101217e57c1d1a8123"; // Stable TMDB Key

/**
 * Parses Kitsu ID format: kitsu:id[:season]
 */
function parseKitsuId(id) {
  const strId = String(id);
  return strId.match(/^kitsu:(\d+)(?::(\d+))?$/);
}

/**
 * Resolves a Kitsu ID to English and Canonical titles
 */
function resolveKitsuTitle(kitsuId) {
  const url = `https://kitsu.io/api/edge/anime/${kitsuId}`;
  return fetch(url)
    .then(res => {
      if (!res.ok) throw new Error(`Kitsu API HTTP error! Status: ${res.status}`);
      return res.json();
    })
    .then(json => {
      const attrs = json?.data?.attributes;
      if (!attrs) throw new Error("No attributes in Kitsu response");
      
      const titles = [];
      if (attrs.canonicalTitle) titles.push(attrs.canonicalTitle);
      if (attrs.titles?.en) titles.push(attrs.titles.en);
      if (attrs.titles?.en_jp) titles.push(attrs.titles.en_jp);
      
      return [...new Set(titles.filter(Boolean))];
    });
}

/**
 * Resolves a TMDB ID to the media title
 */
function resolveTmdbTitle(tmdbId, mediaType) {
  const type = mediaType === "tv" ? "tv" : "movie";
  const url = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${TMDB_API_KEY}`;
  return fetch(url)
    .then(res => {
      if (!res.ok) throw new Error(`TMDB HTTP error! Status: ${res.status}`);
      return res.json();
    })
    .then(json => {
      const titles = [];
      const title = json.name || json.title || json.original_name || json.original_title;
      if (title) titles.push(title);
      return [...new Set(titles.filter(Boolean))];
    });
}

/**
 * Unified title resolver
 */
function resolveTitles(id, mediaType) {
  const kitsuMatch = parseKitsuId(id);
  if (kitsuMatch) {
    return resolveKitsuTitle(kitsuMatch[1]);
  } else {
    return resolveTmdbTitle(id, mediaType);
  }
}

/**
 * Generates alternative seasonal query variants
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
 * Core Nuvio dynamic resolver using murni Promise chains (.then) for Hermes engine safety.
 */
function getStreams(id, mediaType, season, episode) {
  console.log(`[Kuronime] Starting lookup for ID: ${id} (${mediaType}) Season: ${season} Episode: ${episode}`);
  
  return resolveTitles(id, mediaType)
    .then(titles => {
      if (!titles || titles.length === 0) {
        console.log(`[Kuronime] Failed to resolve titles for ID: ${id}`);
        return [];
      }
      
      const isKitsu = parseKitsuId(id);
      let searchTerms = [];
      
      // If it's a Kitsu ID, Kitsu already has separate season entries (titles are already season-specific)
      // If standard TMDB ID, we generate seasonal suffixes
      if (isKitsu) {
        searchTerms = titles;
      } else {
        searchTerms = getAlternativeTitles(titles[0], season);
      }
      
      const searchQuery = searchTerms[0].replace(/[:\-–—()]/g, ' ').replace(/\s+/g, ' ').trim();
      const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(searchQuery)}`;
      console.log(`[Kuronime] Querying: "${searchQuery}" -> ${searchUrl}`);
      
      return fetch(searchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
      })
      .then(res => {
        if (!res.ok) throw new Error(`Search request failed! Status: ${res.status}`);
        return res.text();
      })
      .then(html => {
        const $ = cheerio.load(html);
        let animeUrl = null;
        
        $('h4 a').each((index, element) => {
          const resultTitle = $(element).text().trim().toLowerCase();
          const href = $(element).attr('href');
          
          const isMatch = searchTerms.some(term => {
            const t = term.toLowerCase();
            return resultTitle.includes(t) || t.includes(resultTitle);
          });
          
          if (isMatch && href) {
            animeUrl = href;
            return false; // Break
          }
        });
        
        if (!animeUrl) {
          console.log(`[Kuronime] No matched series page found for search terms.`);
          return [];
        }
        
        console.log(`[Kuronime] Found series page: ${animeUrl}`);
        
        if (mediaType === "tv") {
          return fetch(animeUrl)
            .then(res => {
              if (!res.ok) throw new Error(`Series page HTTP error! Status: ${res.status}`);
              return res.text();
            })
            .then(mainHtml => {
              const $main = cheerio.load(mainHtml);
              let targetEpisodeUrl = null;
              
              $main('.muvipro-episode-list a, .episode-list a, .eps-list a, a').each((index, element) => {
                const linkText = $main(element).text().trim().toLowerCase();
                const href = $main(element).attr('href');
                
                const epsRegex = new RegExp(`\\b(eps|ep|episode|epsode)\\b\\s*${episode}\\b|\\b${episode}\\b`);
                if (epsRegex.test(linkText) && href && href.includes('episode')) {
                  targetEpisodeUrl = href;
                  return false; // Break
                }
              });
              
              if (!targetEpisodeUrl) {
                const slug = animeUrl.replace(/\/$/, "").split("/").pop();
                targetEpisodeUrl = `${BASE_URL}/${slug}-episode-${episode}/`;
                console.log(`[Kuronime] Episode list link not found. Constructing fallback URL: ${targetEpisodeUrl}`);
              } else {
                console.log(`[Kuronime] Found exact episode page: ${targetEpisodeUrl}`);
              }
              
              return fetch(targetEpisodeUrl).then(res => {
                if (!res.ok) throw new Error(`Episode page HTTP error! Status: ${res.status}`);
                return res.text();
              });
            });
        }
        
        // Movie
        return fetch(animeUrl).then(res => {
          if (!res.ok) throw new Error(`Movie page HTTP error! Status: ${res.status}`);
          return res.text();
        });
      })
      .then(episodeHtml => {
        if (!episodeHtml || episodeHtml.length === 0) return [];
        const $ = cheerio.load(episodeHtml);
        const streams = [];
        
        $('iframe, select option, source').each((index, element) => {
          let src = $(element).attr('src') || $(element).attr('value') || $(element).attr('data-src');
          if (src) {
            if (src.startsWith('//')) src = 'https:' + src;
            
            if (src.includes('m3u8') || src.includes('embed') || src.includes('player') || src.includes('stream') || src.includes('154.203')) {
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
          }
        });
        
        console.log(`[Kuronime] Extraction complete. Discovered ${streams.length} stream links.`);
        return streams;
      });
    })
    .catch(error => {
      console.error(`[Kuronime] Pipeline failed:`, error.message);
      return [];
    });
}

module.exports = { getStreams };