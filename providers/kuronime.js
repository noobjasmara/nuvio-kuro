// Kuronime Provider for Nuvio (Production-Grade Promise-based)
const cheerio = require('cheerio-without-node-native');

const PRIMARY_IP = '154.203.162.226';
const FALLBACK_IP = '154.203.167.220';
const TMDB_API_KEY = '844132b4db1b13101217e57c1d1a8123';

function log(msg) {
  console.log(`[Kuronime] ${msg}`);
}

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  return new Promise((resolve, reject) => {
    log(`Starting lookup for ID: ${tmdbId} (${mediaType}) Season: ${seasonNum} Episode: ${episodeNum}`);

    if (mediaType !== 'tv') {
      log('Only TV/Anime content is supported by Kuronime.');
      return resolve([]);
    }

    // 1. Fetch metadata from TMDB
    const tmdbUrl = `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}`;
    
    fetch(tmdbUrl)
      .then(res => {
        if (!res.ok) throw new Error(`TMDB responded with status ${res.status}`);
        return res.json();
      })
      .then(tmdbData => {
        const showName = tmdbData.name || '';
        let seasonName = '';
        if (tmdbData.seasons) {
          const sObj = tmdbData.seasons.find(s => s.season_number === seasonNum);
          if (sObj) seasonName = sObj.name || '';
        }

        log(`Resolved TMDB Show Name: "${showName}", Season Name: "${seasonName}"`);
        
        // Determine search query
        let query = showName;
        if (seasonName && seasonName !== `Season ${seasonNum}`) {
          query = `${showName} ${seasonName}`;
        }

        return performSearch(query, seasonNum, episodeNum);
      })
      .then(streams => {
        resolve(streams);
      })
      .catch(err => {
        log(`Pipeline failed: ${err.message}`);
        resolve([]); // Resolve empty array on error to prevent Nuvio crash
      });
  });
}

function performSearch(query, seasonNum, episodeNum) {
  // Try primary IP first, then fallback
  return fetchPageWithFallback(`/?s=${encodeURIComponent(query)}`)
    .then(html => {
      const $ = cheerio.load(html);
      const links = [];

      $('article, .post-item, .item').each((index, el) => {
        const title = $(el).find('h2, .entry-title, .title').text().trim();
        const href = $(el).find('a').attr('href') || '';
        if (title && href) {
          links.push({ title, href });
        }
      });

      log(`Found ${links.length} potential matches in search results`);

      // Filter matches containing our target episode
      const match = findBestMatch(links, seasonNum, episodeNum);
      if (!match) {
        log(`No matching post found for Season ${seasonNum} Episode ${episodeNum}`);
        return [];
      }

      log(`Best match post: "${match.title}" -> ${match.href}`);
      return extractStreamsFromPost(match.href);
    });
}

function findBestMatch(links, seasonNum, episodeNum) {
  // Match episode numbers and season numbers in post titles
  const epPattern = new RegExp(`(ep|episode|eps|\\b)\\s*0*${episodeNum}\\b`, 'i');
  
  for (let link of links) {
    const title = link.title.toLowerCase();
    
    // Kuronime titles usually contain both name and episode
    if (epPattern.test(title)) {
      return link;
    }
  }
  return null;
}

function extractStreamsFromPost(postUrl) {
  // Extract path and resolve on fallback IPs
  const path = postUrl.replace(/^https?:\/\/[^\/]+/, '');
  
  return fetchPageWithFallback(path)
    .then(html => {
      const $ = cheerio.load(html);
      const streams = [];

      // Parse video elements, iframes, embed players, etc.
      $('iframe, video source, embed').each((index, el) => {
        let url = $(el).attr('src') || $(el).attr('value') || '';
        if (url) {
          if (url.startsWith('//')) url = 'https:' + url;
          streams.push({
            name: 'Kuronime Stream',
            title: `Mirror ${index + 1}`,
            url: url,
            quality: '720p',
            headers: {
              'Referer': `http://${PRIMARY_IP}/`,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
          });
        }
      });

      log(`Successfully resolved ${streams.length} direct streams`);
      return streams;
    });
}

function fetchPageWithFallback(path) {
  const primaryUrl = `http://${PRIMARY_IP}${path}`;
  const fallbackUrl = `http://${FALLBACK_IP}${path}`;

  log(`Attempting fetch from: ${primaryUrl}`);
  return fetch(primaryUrl)
    .then(res => {
      if (!res.ok) throw new Error(`Status ${res.status}`);
      return res.text();
    })
    .catch(err => {
      log(`Primary IP failed, trying fallback IP... (${err.message})`);
      return fetch(fallbackUrl)
        .then(res => {
          if (!res.ok) throw new Error(`Fallback Status ${res.status}`);
          return res.text();
        });
    });
}

// Export for React Native compatibility
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}
  
