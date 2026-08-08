// Kuronime Provider for Nuvio (Production-Grade Promise-based)
const cheerio = require('cheerio-without-node-native');

const PRIMARY_IP = '154.203.162.226';
const FALLBACK_IP = '154.203.167.220';
const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c'; // Stable active TMDB Key

function log(msg) {
  console.log(`[Kuronime] ${msg}`);
}

function isStreamHost(url) {
  if (!url) return false;
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
         u.includes('pixeldrain.com') ||
         u.includes('ok.ru') ||
         u.includes('gembed') ||
         u.includes('player') ||
         u.includes('154.203.162.226') ||
         u.includes('154.203.167.220');
}

function getDomainName(url) {
  const match = url.match(/https?:\/\/([^\/]+)/i);
  return match ? match[1] : 'Direct';
}

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  return new Promise((resolve) => {
    log(`Starting lookup for ID: ${tmdbId} (${mediaType}) Season: ${seasonNum} Episode: ${episodeNum}`);
    
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
        resolve([]); // Graceful fallback
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

function resolveStreamUrl(url) {
  const u = url.toLowerCase();
  if (u.includes('sibnet.ru')) {
    return fetch(url)
      .then(res => res.text())
      .then(html => {
        const s = html.match(/file\s*:\s*["']([^"']*\.mp4[^"']*)['"]/i) || html.match(/src\s*:\s*["']([^"']*\.mp4[^"']*)['"]/i);
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
        const s = html.match(/sources\s*:\s*\[["']([^"']+\.(?:mp4|m3u8))["']\]/) || html.match(/file\s*:\s*["']([^"']+\.(?:mp4|m3u8))["']/);
        if (s) return s[1];
        return url;
      })
      .catch(() => url);
  }
  return Promise.resolve(url);
}

function extractStreamsFromPost(postUrl) {
  const path = postUrl.replace(/^https?:\/\/[^\/]+/, '');
  return fetchPageWithFallback(path)
    .then(html => {
      const $ = cheerio.load(html);
      const streams = [];
      const urlSet = new Set();
      
      const addStream = (url, label) => {
        if (!url) return;
        if (url.startsWith('//')) url = 'https:' + url;
        if (url.startsWith('/')) url = `http://${PRIMARY_IP}` + url; // Convert relative URLs
        
        if (isStreamHost(url) && !urlSet.has(url)) {
          urlSet.add(url);
          streams.push({ url, label });
        }
      };

      // 1. Gather all hrefs from any <a> tags
      $('a').each((i, el) => {
        addStream($(el).attr('href'), $(el).text().trim() || 'Link');
      });

      // 2. Gather all src from any iframe, video, source, embed tags
      $('iframe, video, source, embed').each((i, el) => {
        let src = $(el).attr('src') || $(el).attr('value') || $(el).attr('data-src') || '';
        addStream(src, `Mirror ${i + 1}`);
      });

      // 3. Scan elements with common data attributes (Muvipro AJAX tab players)
      $('[data-embed], [data-src], [data-video], [data-link], .player-option, .muvi-player-select li').each((i, el) => {
        const embedHtml = $(el).attr('data-embed') || $(el).attr('data-src') || $(el).attr('data-video') || $(el).attr('data-link') || '';
        if (embedHtml) {
          if (embedHtml.includes('<iframe')) {
            const match = embedHtml.match(/src=["']([^"']+)["']/i);
            if (match) addStream(match[1], `Server ${i + 1}`);
          } else {
            addStream(embedHtml, `Server ${i + 1}`);
          }
        }
      });

      // 4. Scan the entire raw HTML for any match of streaming URLs as a last resort
      const regex = /https?:\/\/[^\s"'<>\(\)]+/gi;
      let match;
      while ((match = regex.exec(html)) !== null) {
        let u = match[0];
        u = u.replace(/[.,;:\)\}\\]+$/, '');
        addStream(u, 'Direct Stream');
      }

      log(`Found ${streams.length} raw streams after scanning all layers.`);
      
      const resolvedStreams = [];
      const resolvePromises = streams.map(s => {
        return resolveStreamUrl(s.url)
          .then(resolvedUrl => {
            if (resolvedUrl) {
              resolvedStreams.push({
                name: `Kuronime | ${s.label}`,
                title: `Kuronime - Source: ${getDomainName(s.url)}`,
                url: resolvedUrl,
                quality: '720p',
                headers: {
                  'Referer': `http://${PRIMARY_IP}/`,
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
              });
            }
          })
          .catch(() => {});
      });
      
      return Promise.all(resolvePromises).then(() => {
        log(`Successfully resolved ${resolvedStreams.length} active streams`);
        return resolvedStreams;
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
