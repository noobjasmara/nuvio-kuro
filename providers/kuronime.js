// Kuronime Provider for Nuvio v1.4.1 (Promise-based & Advanced Muvipro Multi-Server Resolver)
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
        resolve([]);
      });
  });
}

function performSearch(query, seasonNum, episodeNum, tmdbType) {
  return fetchPageWithFallback(`/?s=${encodeURIComponent(query)}`)
    .then(html => {
      const $ = cheerio.load(html);
      const links = [];
      
      $('article, .post-item, .item, .bsx, .listupd .main-meta').each((index, el) => {
        const title = $(el).find('h2, .entry-title, .title, .tt, .entry-title a').text().trim() || $(el).find('a').attr('title') || '';
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
      return extractStreamsFromPost(match.href, episodeNum, tmdbType);
    });
}

function findBestMatch(links, seasonNum, episodeNum, tmdbType) {
  if (tmdbType === 'movie') {
    return links[0] || null;
  }
  
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

function isStreamHost(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.toLowerCase();
  const hosts = [
    'sibnet.ru', 'vidmoly', 'uqload', 'voe', 'streamtape', 'dood', 
    'filemoon', 'sendvid', 'megaplay', 'lecteurvideo', 'zencloudz', 
    'younetu', 'mp4upload', 'yourupload', 'solidfiles', 'krakenfiles', 
    'pixeldrain', 'fileditch', 'gembed', 'gdriveplayer', 'blogspot', 
    'blogger.com', 'google.com/file', 'googleapis.com'
  ];
  return hosts.some(host => u.includes(host));
}

function getDomainName(url) {
  const match = url.match(/https?:\/\/([^\/]+)/i);
  return match ? match[1] : 'Direct';
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

function extractStreamsFromPost(postUrl, episodeNum, tmdbType) {
  const path = postUrl.replace(/^https?:\/\/[^\/]+/, '');
  return fetchPageWithFallback(path)
    .then(html => {
      const $ = cheerio.load(html);
      
      // 1. Check if this is a main TV show page and we need to navigate to the specific episode subpage
      let episodeUrl = '';
      
      // Look for explicit links to episodes (common in Muvipro TV show layouts)
      $('a').each((i, el) => {
        const href = $(el).attr('href') || '';
        const text = $(el).text().trim().toLowerCase();
        const titleAttr = ($(el).attr('title') || '').toLowerCase();
        
        if (href && (href.includes('/eps/') || href.includes('/episode/'))) {
          const epTextPattern = new RegExp(`^(?:eps|episode)?\\s*0*${episodeNum}$`, 'i');
          if (epTextPattern.test(text) || text === `eps${episodeNum}` || text === `eps0${episodeNum}` || titleAttr.includes(`episode ${episodeNum}`)) {
            episodeUrl = href;
            return false; // break loop
          }
        }
      });
      
      // Fallback matching for episode links if not resolved above
      if (!episodeUrl && tmdbType !== 'movie') {
        $('a').each((i, el) => {
          const href = $(el).attr('href') || '';
          const text = $(el).text().trim().toLowerCase();
          if (href && (href.includes('/eps/') || href.includes('/episode/'))) {
            const matchesEp = new RegExp(`\\b0*${episodeNum}\\b`);
            if (matchesEp.test(text)) {
              episodeUrl = href;
              return false;
            }
          }
        });
      }
      
      if (episodeUrl && episodeUrl !== postUrl) {
        log(`Navigating from series page to target episode subpage: ${episodeUrl}`);
        const subPath = episodeUrl.replace(/^https?:\/\/[^\/]+/, '');
        return fetchPageWithFallback(subPath).then(epHtml => parseEpisodePage(epHtml));
      }
      
      return parseEpisodePage(html);
    });
}

function parseEpisodePage(html) {
  const $ = cheerio.load(html);
  const streams = [];
  const urlSet = new Set();
  
  // A. Scrape multi-server streaming tab iFrames
  $('iframe, video, source, embed').each((i, el) => {
    let src = $(el).attr('src') || $(el).attr('value') || $(el).attr('data-src') || '';
    if (src) {
      if (src.startsWith('//')) src = 'https:' + src;
      if (isStreamHost(src) && !urlSet.has(src)) {
        urlSet.add(src);
        streams.push({ url: src, label: `Mirror ${i + 1}` });
      }
    }
  });
  
  // B. Parse download links as streaming sources (extremely rich and reliable source on Indonesian fansubs)
  $('a').each((i, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim() || 'Download Link';
    if (href && isStreamHost(href) && !urlSet.has(href)) {
      urlSet.add(href);
      streams.push({ url: href, label: text });
    }
  });
  
  // C. Parse data attributes of play buttons (for AJAX players)
  $('[data-embed], [data-src], [data-code], [data-url], [data-video]').each((i, el) => {
    let src = $(el).attr('data-embed') || $(el).attr('data-src') || $(el).attr('data-code') || $(el).attr('data-url') || $(el).attr('data-video') || '';
    if (src) {
      if (src.startsWith('//')) src = 'https:' + src;
      if (isStreamHost(src) && !urlSet.has(src)) {
        urlSet.add(src);
        streams.push({ url: src, label: $(el).text().trim() || `Player ${i + 1}` });
      }
    }
  });

  // D. Scan raw page HTML for any unparsed stream URLs
  const regex = /https?:\/\/[^\s"'<>\(\)]+/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    let u = match[0];
    u = u.replace(/[.,;:\)\\}\\]+$/, '');
    if (isStreamHost(u) && !urlSet.has(u)) {
      urlSet.add(u);
      streams.push({ url: u, label: 'Direct Stream' });
    }
  }
  
  log(`Found ${streams.length} total raw streaming options after scanning all layers.`);
  
  const resolvedStreams = [];
  const resolvePromises = streams.map(s => {
    return resolveStreamUrl(s.url)
      .then(resolvedUrl => {
        if (resolvedUrl) {
          resolvedStreams.push({
            name: `Kuronime | ${s.label}`,
            title: `Kuronime Stream\nSource: ${getDomainName(s.url)}`,
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
    log(`Successfully resolved ${resolvedStreams.length} active play links.`);
    return resolvedStreams;
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
    }
