// providers/kuronime.js
const cheerio = require('cheerio-without-node-native');

const BASE_URL = "https://154.203.162.226"; // Active Kuronime IP/Domain
const TMDB_API_KEY = "844132b4db1b13101217e57c1d1a8123"; // Fallback TMDB key for title resolution

// Traditional Promise-based helper for fetch
function fetchJson(url) {
  return fetch(url).then(function(res) {
    if (!res.ok) throw new Error("HTTP error " + res.status);
    return res.json();
  });
}

function fetchText(url, headers) {
  return fetch(url, { headers: headers || {} }).then(function(res) {
    if (!res.ok) throw new Error("HTTP error " + res.status);
    return res.text();
  });
}

/**
 * Resolves kitsu, imdb, tvdb, or tmdb IDs to canonical title and isAnime metadata
 */
function resolveMedia(id, mediaType) {
  const type = mediaType === "tv" ? "tv" : "movie";
  
  // 1. Kitsu ID
  if (typeof id === 'string' && id.startsWith('kitsu:')) {
    const kitsuId = id.split(':')[1];
    return fetchJson("https://kitsu.io/api/edge/anime/" + kitsuId)
      .then(function(json) {
        const attr = json.data.attributes;
        const title = attr.canonicalTitle || attr.titles.en || attr.titles.en_jp;
        return {
          tmdbId: null,
          title: title.replace(/[:\-–—()]/g, ' ').replace(/\s+/g, ' ').trim(),
          isAnime: true
        };
      });
  }

  // 2. IMDb ID
  if (typeof id === 'string' && id.startsWith('tt')) {
    return fetchJson("https://api.themoviedb.org/3/find/" + id + "?api_key=" + TMDB_API_KEY + "&external_source=imdb_id")
      .then(function(json) {
        const result = mediaType === 'tv' ? json.tv_results[0] : json.movie_results[0];
        if (!result) throw new Error("Not found via IMDb find");
        return {
          tmdbId: result.id,
          title: (result.original_name || result.original_title || result.name || result.title).replace(/[:\-–—()]/g, ' ').replace(/\s+/g, ' ').trim(),
          isAnime: (result.original_language === 'ja')
        };
      });
  }

  // 3. Numeric ID (Try TVDB find first, then TMDB direct)
  return fetch("https://api.themoviedb.org/3/find/" + id + "?api_key=" + TMDB_API_KEY + "&external_source=tvdb_id")
    .then(function(res) {
      if (!res.ok) return null;
      return res.json();
    })
    .then(function(json) {
      const result = json && json.tv_results && json.tv_results[0];
      if (result) {
        console.log("[Kuronime] Resolved TVDB ID " + id + " -> TMDB ID " + result.id);
        return {
          tmdbId: result.id,
          title: (result.original_name || result.original_title || result.name || result.title).replace(/[:\-–—()]/g, ' ').replace(/\s+/g, ' ').trim(),
          isAnime: (result.original_language === 'ja')
        };
      }
      
      // Fallback: Assume it's already a TMDB ID
      return fetchJson("https://api.themoviedb.org/3/" + type + "/" + id + "?api_key=" + TMDB_API_KEY)
        .then(function(data) {
          return {
            tmdbId: data.id,
            title: (data.original_name || data.original_title || data.name || data.title).replace(/[:\-–—()]/g, ' ').replace(/\s+/g, ' ').trim(),
            isAnime: (data.original_language === 'ja' || (data.genres || []).some(function(g) { return g.id === 16; }))
          };
        });
    });
}

/**
 * Resolves seasonal split anime titles and relative episode numbers via AniZip & AniList
 */
function resolveSeasonalTitleAndEpisode(tmdbId, season, episode) {
  if (!tmdbId || !season || season === 1) {
    return Promise.resolve({ titles: null, episode: episode });
  }

  const url = "https://api.ani.zip/v1/anime?tmdb_id=" + tmdbId;
  return fetch(url)
    .then(function(res) {
      if (!res.ok) throw new Error("AniZip API status: " + res.status);
      return res.json();
    })
    .then(function(data) {
      if (!data || !data.episodes) return { titles: null, episode: episode };
      
      let matchedEpisode = null;
      for (const key in data.episodes) {
        const ep = data.episodes[key];
        if (ep.season === season && ep.episode === episode) {
          matchedEpisode = ep;
          break;
        }
      }

      if (!matchedEpisode) {
        console.log("[Kuronime] No AniZip episode match for S" + season + "E" + episode);
        return { titles: null, episode: episode };
      }

      const anilistId = matchedEpisode.anilistId;
      if (!anilistId) {
        console.log("[Kuronime] Found AniZip match, but no AniList ID. Fallback absolute episode: " + matchedEpisode.absoluteEpisodeNumber);
        return { titles: null, episode: matchedEpisode.absoluteEpisodeNumber || episode };
      }

      console.log("[Kuronime] AniZip mapped S" + season + "E" + episode + " to AniList ID: " + anilistId);

      const gqlQuery = 'query ($id: Int) { Media (id: $id, type: ANIME) { title { romaji english native } } }';

      return fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          query: gqlQuery,
          variables: { id: anilistId }
        })
      })
      .then(function(res) {
        if (!res.ok) throw new Error("AniList GraphQL returned status: " + res.status);
        return res.json();
      })
      .then(function(gqlJson) {
        const media = gqlJson && gqlJson.data && gqlJson.data.Media;
        if (!media || !media.title) return { titles: null, episode: matchedEpisode.absoluteEpisodeNumber || episode };

        const titles = [
          media.title.romaji,
          media.title.english,
          media.title.native
        ].filter(Boolean).map(function(t) {
          return t.replace(/[:\-–—()]/g, ' ').replace(/\s+/g, ' ').trim();
        });

        console.log("[Kuronime] Resolved AniList titles: " + titles.join(' | '));
        
        const relativeEpisode = matchedEpisode.episode || episode;
        console.log("[Kuronime] AniList split relative episode: " + relativeEpisode);

        return {
          titles: titles,
          episode: relativeEpisode
        };
      })
      .catch(function(err) {
        console.error("[Kuronime] AniList title resolution error:", err.message);
        return { titles: null, episode: matchedEpisode.absoluteEpisodeNumber || episode };
      });
    })
    .catch(function(err) {
      console.error("[Kuronime] AniZip resolution error:", err.message);
      return { titles: null, episode: episode };
    });
}

/**
 * Programmatically generates search queries based on season or specific anime titles
 */
function getSearchQueries(baseTitle, season, animeTitles) {
  if (animeTitles && animeTitles.length > 0) {
    return animeTitles;
  }
  if (!season || season === 1) {
    return [baseTitle];
  }
  const romanNumerals = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX"];
  const roman = romanNumerals[season] || "";
  
  const list = [];
  if (roman) list.push(baseTitle + " " + roman);
  list.push(baseTitle + " Season " + season);
  list.push(baseTitle + " S" + season);
  list.push(baseTitle);
  return list;
}

/**
 * Searches Kuronime sequentially using search query candidates
 */
function searchKuronime(queries, index) {
  if (index >= queries.length) {
    return Promise.resolve(null);
  }

  const query = queries[index];
  console.log("[Kuronime] Attempting search for: " + query + " (index " + index + ")");
  const searchUrl = BASE_URL + "/?s=" + encodeURIComponent(query);

  return fetchText(searchUrl, {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  })
  .then(function(html) {
    const $ = cheerio.load(html);
    let animeUrl = null;

    // Parse WordPress search results (Muvipro theme uses h4 elements for titles)
    $('h4 a').each(function(i, element) {
      const resultTitle = $(element).text().trim().toLowerCase();
      const href = $(element).attr('href');

      // Check if result title matches our search candidates
      const isMatch = queries.some(function(term) {
        const t = term.toLowerCase();
        return resultTitle.includes(t) || t.includes(resultTitle);
      });

      if (isMatch && href) {
        animeUrl = href;
        return false; // Break cheerio loop
      }
    });

    if (animeUrl) {
      console.log("[Kuronime] Found search match: " + animeUrl);
      return animeUrl;
    }

    // If not found, try next query
    return searchKuronime(queries, index + 1);
  })
  .catch(function(err) {
    console.error("[Kuronime] Search error for " + query + ":", err.message);
    return searchKuronime(queries, index + 1);
  });
}

/**
 * Finds specific episode page inside a show's main catalog page on Kuronime
 */
function findEpisodePage(animeUrl, episode, targetEpisodeNumber) {
  return fetchText(animeUrl, {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
  })
  .then(function(mainPageHtml) {
    const $main = cheerio.load(mainPageHtml);
    let targetEpisodeUrl = null;

    // Search link texts
    $main('.muvipro-episode-list a, .episode-list a, .eps-list a, a').each(function(i, element) {
      const linkText = $main(element).text().trim().toLowerCase();
      const href = $main(element).attr('href');

      // Match "Episode X" or "Eps X" or "Ep X" or standalone number X
      const epsRegex = new RegExp('\\b(eps|ep|episode|epsode)\\b\\s*' + targetEpisodeNumber + '\\b|\\b' + targetEpisodeNumber + '\\b');
      if (epsRegex.test(linkText) && href && href.includes('episode')) {
        targetEpisodeUrl = href;
        return false; // Found exact match, break loop
      }
    });

    // Fallback: If link not found, try generating standard slug
    if (!targetEpisodeUrl) {
      const slug = animeUrl.replace(/\/$/, "").split("/").pop();
      targetEpisodeUrl = BASE_URL + "/" + slug + "-episode-" + targetEpisodeNumber + "/";
      console.log("[Kuronime] Episode list match failed. Standardizing fallback slug: " + targetEpisodeUrl);
    } else {
      console.log("[Kuronime] Discovered exact episode URL: " + targetEpisodeUrl);
    }

    return targetEpisodeUrl;
  });
}

/**
 * Extracts iframe play urls from target episode page
 */
function extractStreams(pageUrl) {
  return fetchText(pageUrl, {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
  })
  .then(function(html) {
    const $ = cheerio.load(html);
    const streams = [];

    // Scrape players (iframe elements, select options, or video sources)
    $('iframe, select option, source').each(function(index, element) {
      let src = $(element).attr('src') || $(element).attr('value') || $(element).attr('data-src');
      if (src && (src.includes('m3u8') || src.includes('embed') || src.includes('player') || src.includes('stream'))) {
        if (src.startsWith('//')) src = 'https:' + src;

        streams.push({
          name: "Kuronime",
          title: "Server " + (index + 1) + " (Sub Indo)",
          url: src,
          quality: "720p",
          headers: {
            "Referer": BASE_URL,
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
          }
        });
      }
    });

    console.log("[Kuronime] Extraction complete. Found " + streams.length + " streams.");
    return streams;
  });
}

/**
 * Main getStreams interface
 */
function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[Kuronime] Initializing resolver for ID: " + tmdbId + " (" + mediaType + ")");

  return resolveMedia(tmdbId, mediaType)
    .then(function(media) {
      if (!media) {
        console.log("[Kuronime] Metadata resolution failed. Search aborted.");
        return [];
      }

      console.log("[Kuronime] Resolved Title: " + media.title + " | isAnime: " + media.isAnime);

      // Resolve seasonal mapping if it's anime and season > 1
      const isAnimeTv = media.isAnime && mediaType === "tv" && season && season > 1;
      const seasonalPromise = isAnimeTv 
        ? resolveSeasonalTitleAndEpisode(media.tmdbId, season, episode)
        : Promise.resolve({ titles: null, episode: episode });

      return seasonalPromise.then(function(resolvedMapping) {
        const targetEpisodeNumber = resolvedMapping.episode;
        const searchQueries = getSearchQueries(media.title, season, resolvedMapping.titles);

        console.log("[Kuronime] Search queries candidates: " + searchQueries.join(" | "));
        console.log("[Kuronime] Target episode number: " + targetEpisodeNumber);

        return searchKuronime(searchQueries, 0)
          .then(function(animeUrl) {
            if (!animeUrl) {
              console.log("[Kuronime] No match found on Kuronime search.");
              return [];
            }

            const targetPagePromise = mediaType === "tv"
              ? findEpisodePage(animeUrl, episode, targetEpisodeNumber)
              : Promise.resolve(animeUrl);

            return targetPagePromise.then(function(targetPageUrl) {
              console.log("[Kuronime] Fetching and extracting stream links from: " + targetPageUrl);
              return extractStreams(targetPageUrl);
            });
          });
      });
    })
    .catch(function(error) {
      console.error("[Kuronime] Resolver caught an error:", error.message);
      return [];
    });
}

// React Native / Hermes module registration compatibility
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams: getStreams };
} else {
  global.getStreams = getStreams;
}