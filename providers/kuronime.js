// Kuronime Provider for Nuvio (Production-Grade Scoped Scraper)
const cheerio = require('cheerio-without-node-native');

const PRIMARY_IP = '154.203.162.226';
const FALLBACK_IP = '154.203.167.220';
const TMDB_API_KEY = '844132b4db1b13101217e57c1d1a8123';

function log(msg) {
  console.log(`[Kuronime] ${msg}`);
}

function isStreamHost(url) {
  const u = url.toLowerCase();
  return u.includes('sibnet.ru') || 
         u.includes('vidmoly.') || 
         u.includes('uqload.') || 
         u.includes('voe.') || 
         u.includes('streamtape.') || 
         u.includes('dood.') || 
         u.includes('filemoon.') || 
         u.includes('sendvid.') || 
         u.includes('megaplay.') || 
         u.includes('lecteurvideo.') || 
         u.includes('zencloudz.') || 
         u.includes('younetu.') ||
         u.includes('blogger.com') ||
         u.includes('blogspot.com') ||
         u.includes('pixeldrain.com');
}

function getDomainName(url) {
  const match = url.match(/https?:\/\/([^\/]+)/i);
  return match ? match[1] : 'Direct';
}

function resolveStreamUrl(url) {
  const u = url.toLowerCase();
  // We resolve the stream page HTML to look for direct files if possible
  if (u.includes('sibnet.ru')) {
    return fetch(url)
      .then(res => res.text())
      .then(html => {
        const s = html.match(/file\s*:\s*["']([^"']*\.mp4[^"']*)['"]/i) || 
                  html.match(/src\s*:\s*["']([^"']*\.mp4[^"']*)['"]/i);
        if (s) {
          let videoUrl = s[1];
          if (videoUrl.startsWith('//')) videoUrl = 'https:' + videoUrl;
          return videoUrl;
        }
        return url;
      })
      .catch(() => url);
  } else if (u.includes('uqload.')) {
    return fetch(url)
      .then(res => res.text())
      .then(html => {
        const s = html.match(/sources\s*:\s*\[["']([^"']+\.(?:mp4|m3u8))["']\]/) || 
                  html.match(/file\s*:\s*["']([^"']+\.(?:mp4|m3u8))["']/);
        if (s) return s[1];
        return url;
      })
      .catch(() => url);
  }
  return Promise.resolve(url);
}

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  return new Promise((resolve, reject) => {
    log(`Starting lookup for ID: ${tmdbId} (${mediaType}) Season: ${seasonNum} Episode: ${episodeNum}`);
    
    // Support tv series primarily
    const tmdbType = (mediaType === 'tv' || mediaType === 'series') ? 'tv' : 'movie';
    const tmdbUrl = `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${TMDB_API_KEY}`;
    
    fetch(tmdbUrl)
      .then(res => {
        if (!res.ok) throw new Error(`TMDB responded with status ${res.status}`);
        return res.json();
      })
      .then(tmdbData => {
        const showName = tmdbData.name || tmdbData.title || '';
        let seasonName = '';
        if (tmdbType === 'tv' && tmdbData.seasons) {
          const sObj = tmdbData.seasons.find(s => s.season_number === seasonNum);
          if (sObj) seasonName = sObj.name || '';
        }
        log(`Resolved TMDB Show Name: "${showName}", Season Name: "${seasonName}"`);
        
        // Build robust search query
        let query = showName;
        if (seasonName && seasonName !== `Season ${seasonNum}`) {
          query = `${showName} ${seasonName}`;
        }
        return performSearch(query, seasonNum, episodeNum, tmdbType);
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

function performSearch(query, seasonNum, episodeNum, tmdbType) {
  return fetchPageWithFallback(`/?s=${encodeURIComponent(query)}`)
    .then(html => {
      const $ = cheerio.load(html);
      const links = [];
      $('article, .post-item, .item, .bsx').each((index, el) => {
        const title = $(el).find('h2, .entry-title, .title, .tt').text().trim();
        const href = $(el).find('a').attr('href') || '';
        if (title && href) {
          links.push({ title, href });
        }
      });
      log(`Found ${links.length} potential matches in search results`);
      
      const match = findBestMatch(links, seasonNum, episodeNum, tmdbType);
      if (!match) {
        log(`No matching post found for Season ${seasonNum} Episode ${episodeNum}`);
        return [];
      }
      log(`Best match post: "${match.title}" -> ${match.href}`);
      return extractStreamsFromPost(match.href);
    });
}

function findBestMatch(links, seasonNum, episodeNum, tmdbType) {
  if (tmdbType === 'movie') {
    return links[0] || null;
  }
  
  // Smarter matching pattern for Indonesian WordPress episode names
  const epPatterns = [
    new RegExp(`(?:ep|episode|eps|\\b)\\s*0*${episodeNum}\\b`, 'i'),
    new RegExp(`\\b0*${episodeNum}\\b`, 'i')
  ];
  
  for (const pattern of epPatterns) {
    for (const link of links) {
      if (pattern.test(link.title)) {
        return link;
      }
    }
  }
  return links[0] || null;
}

function extractStreamsFromPost(postUrl) {
  const path = postUrl.replace(/^https?:\/\/[^\/]+/, '');
  return fetchPageWithFallback(path)
    .then(html => {
      const $ = cheerio.load(html);
      const streams = [];
      const urlSet = new Set();
      
      function addUrl(url, label) {
        if (!url || typeof url !== 'string') return;
        url = url.trim();
        if (url.startsWith('//')) url = 'https:' + url;
        
        if (url.startsWith('http') && isStreamHost(url) && !urlSet.has(url)) {
          urlSet.add(url);
          streams.push({ url, label });
        }
      }

      // Layer 1: Target iframe inside video containers (Highest Priority)
      $('#player-embed iframe, .player-embed iframe, #muvi-player iframe, .videoWrapper iframe, .player-iframe iframe, .video-player iframe').each((i, el) => {
        const src = $(el).attr('src') || $(el).attr('data-src') || '';
        addUrl(src, `Mirror ${i + 1}`);
      });

      // Layer 2: Target player select tabs / option buttons (Muvipro AJAX tabs)
      $('.player-select a, .player-option a, .muvi-player a, #player-option option, .player-option option').each((i, el) => {
        const src = $(el).attr('data-embed') || $(el).attr('data-src') || $(el).attr('value') || $(el).attr('href') || '';
        const name = $(el).text().trim() || `Server ${i + 1}`;
        addUrl(src, name);
      });

      // Layer 3: Target links inside actual player widgets/boxes
      $('.player-box iframe, .player-box a').each((i, el) => {
        const src = $(el).attr('src') || $(el).attr('href') || $(el).attr('data-src') || '';
        const name = $(el).text().trim() || `Player ${i + 1}`;
        addUrl(src, name);
      });

      // Fallback 1: Extract all iframes/embeds if we found absolutely nothing
      if (streams.length === 0) {
        $('iframe, video, source, embed').each((i, el) => {
          const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('value') || '';
          addUrl(src, `Source ${i + 1}`);
        });
      }

      // Fallback 2: Extract any matches from raw content block
      if (streams.length === 0) {
        const contentHtml = $('#player-embed').html() || $('.player-embed').html() || $('.entry-content').html() || html;
        const regex = /https?:\/\/[^\s"\'<>`\(\)]+/gi;
        let match;
        while ((match = regex.exec(contentHtml)) !== null) {
          addUrl(match[0], 'Streaming Link');
        }
      }

      log(`Found ${streams.length} scoped player URLs.`);
      
      const resolvedStreams = [];
      const resolvePromises = streams.map(s => {
        return resolveStreamUrl(s.url)
          .then(resolvedUrl => {
            if (resolvedUrl) {
              resolvedStreams.push({
                name: `Kuronime | ${s.label}`,
                title: `Kuronime - 720p\nSource: ${getDomainName(s.url)}`,
                url: resolvedUrl,
                quality: '720p',
                headers: {
                  'Referer': `http://${PRIMARY_IP}/`,
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
              });
            }
          })
          .catch(() => {});
      });

      return Promise.all(resolvePromises).then(() => {
        const uniqStreams = [];
        const seen = new Set();
        resolvedStreams.forEach(st => {
          if (!seen.has(st.url)) {
            seen.add(st.url);
            uniqStreams.push(st);
          }
        });
        log(`Returning ${uniqStreams.length} clean resolved stream links.`);
        return uniqStreams;
      });
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
