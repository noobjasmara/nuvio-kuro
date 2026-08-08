// Kuronime Provider for Nuvio (Production-Grade Promise-based)
const cheerio = require('cheerio-without-node-native');
const CryptoJS = require('crypto-js');

const PRIMARY_IP = '154.203.162.226';
const FALLBACK_IP = '154.203.167.220';
const TMDB_API_KEY = '844132b4db1b13101217e57c1d1a8123';
const MIRROR_PASSWORD = '3&!Z0M,VIZ;dZW==';

function log(msg) {
  console.log(`[Kuronime] ${msg}`);
}

function fetchPageWithFallback(path) {
  const primaryUrl = `http://${PRIMARY_IP}${path}`;
  const fallbackUrl = `http://${FALLBACK_IP}${path}`;
  
  log(`Attempting fetch from: ${primaryUrl}`);
  return fetch(primaryUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  })
  .then(res => {
    if (!res.ok) throw new Error(`Status ${res.status}`);
    return res.text();
  })
  .catch(err => {
    log(`Primary IP failed, trying fallback IP... (${err.message})`);
    return fetch(fallbackUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    })
    .then(res => {
      if (!res.ok) throw new Error(`Fallback Status ${res.status}`);
      return res.text();
    });
  });
}

function decryptPayload(encodedData, password) {
  try {
    const wrapperStr = CryptoJS.enc.Base64.parse(encodedData).toString(CryptoJS.enc.Utf8);
    const wrapper = JSON.parse(wrapperStr);
    
    const ct = wrapper.ct;
    const iv = CryptoJS.enc.Hex.parse(wrapper.iv);
    const salt = CryptoJS.enc.Hex.parse(wrapper.s);
    
    const key = CryptoJS.EvpKDF(password, salt, {
      keySize: 8,
      iterations: 1,
      hasher: CryptoJS.algo.MD5
    });
    
    const decrypted = CryptoJS.AES.decrypt(
      ct,
      key,
      {
        iv: iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
      }
    );
    
    return decrypted.toString(CryptoJS.enc.Utf8);
  } catch (e) {
    console.error('[Kuronime] Decryption failed:', e.message);
    return null;
  }
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
  const u = url.toLowerCase();
  return u.includes('sibnet.ru') || u.includes('vidmoly.') || u.includes('uqload.') || 
         u.includes('voe.') || u.includes('streamtape.') || u.includes('dood.') || 
         u.includes('filemoon.') || u.includes('sendvid.') || u.includes('megaplay.') || 
         u.includes('lecteurvideo.') || u.includes('zencloudz.') || u.includes('younetu.') ||
         u.includes('blogger.com') || u.includes('blogspot.com') || u.includes('pixeldrain.') ||
         u.includes('ok.ru') || u.includes('mp4upload.') || u.includes('gembed') || u.includes('player');
}

function getDomainName(url) {
  const match = url.match(/https?:\/\/([^\/]+)/i);
  return match ? match[1] : 'Direct';
}

function cleanTitle(title) {
  return title.replace(/[^a-zA-Z0-9\s]/g, '').trim();
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
      return navigateAndExtractStreams(match.href, seasonNum, episodeNum, tmdbType);
    });
}

function navigateAndExtractStreams(postUrl, seasonNum, episodeNum, tmdbType) {
  const path = postUrl.replace(/^https?:\/\/[^\/]+/, '');
  
  return fetchPageWithFallback(path)
    .then(html => {
      const $ = cheerio.load(html);
      
      // If it's a TV series main page, we must find and jump to the specific episode page
      if (tmdbType === 'tv' && path.includes('/tv/')) {
        log(`Detected TV main series page. Searching for episode ${episodeNum} link...`);
        let epUrl = '';
        
        $('div.bixbox.bxcl li, .eplister li').each((index, el) => {
          const epText = $(el).find('a').text().trim();
          const href = $(el).find('a').attr('href') || '';
          
          const epMatch = epText.match(/episode\s*0*(\d+)/i) || epText.match(/eps\s*0*(\d+)/i) || epText.match(/\b0*(\d+)\b/);
          if (epMatch && parseInt(epMatch[1], 10) === episodeNum) {
            epUrl = href;
          }
        });
        
        // Fallback: search any links matching "nonton-" + episode number
        if (!epUrl) {
          $('a[href*="/nonton-"]').each((index, el) => {
            const href = $(el).attr('href') || '';
            const title = $(el).text().trim().toLowerCase();
            if (title.includes(`episode ${episodeNum}`) || title.includes(`eps ${episodeNum}`) || href.includes(`-episode-${episodeNum}`)) {
              epUrl = href;
            }
          });
        }
        
        if (epUrl) {
          log(`Navigating to episode page: ${epUrl}`);
          const epPath = epUrl.replace(/^https?:\/\/[^\/]+/, '');
          return fetchPageWithFallback(epPath).then(epHtml => extractFromEpisodePage(epHtml, epUrl));
        } else {
          log(`Could not resolve specific page for Episode ${episodeNum}. Scraping main page directly.`);
          return extractFromEpisodePage(html, postUrl);
        }
      }
      
      return extractFromEpisodePage(html, postUrl);
    });
}

function extractFromEpisodePage(html, refererUrl) {
  const $ = cheerio.load(html);
  const streams = [];
  const urlSet = new Set();
  
  // Try to find the encrypted sources payload (_0xa100d42aa)
  const encryptedIdMatch = html.match(/var\s+_0xa100d42aa\s*=\s*"([^"]+)"/);
  
  if (encryptedIdMatch && encryptedIdMatch[1]) {
    const encryptedId = encryptedIdMatch[1];
    log(`Found encrypted source ID: ${encryptedId}. Querying API...`);
    
    return fetch('https://animeku.org/api/v9/sources', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://kuronime.sbs',
        'Referer': refererUrl,
        'Accept': 'application/json, text/plain, */*'
      },
      body: JSON.stringify({ id: encryptedId })
    })
    .then(res => {
      if (!res.ok) throw new Error(`API sources status ${res.status}`);
      return res.json();
    })
    .then(sourcesJson => {
      const mirror = sourcesJson.mirror || '';
      if (!mirror) return [];
      
      const decryptedStr = decryptPayload(mirror, MIRROR_PASSWORD);
      if (!decryptedStr) return [];
      
      const decrypted = JSON.parse(decryptedStr);
      const candidates = [];
      
      // Parse filelions
      if (decrypted.filelions) {
        candidates.push({ url: decrypted.filelions, label: 'Filelions (Decrypted)' });
      }
      // Parse blog
      if (decrypted.blog) {
        candidates.push({ url: decrypted.blog, label: 'Blogger (Decrypted)' });
      }
      // Parse raw
      if (decrypted.raw) {
        candidates.push({ url: decrypted.raw, label: 'Direct Raw (Decrypted)' });
      }
      // Parse embed map
      if (decrypted.embed) {
        Object.keys(decrypted.embed).forEach(quality => {
          const hosts = decrypted.embed[quality];
          Object.keys(hosts).forEach(hostName => {
            const hostUrl = hosts[hostName];
            if (hostUrl && !hostUrl.includes('ads') && isStreamHost(hostUrl)) {
              candidates.push({ url: hostUrl, label: `${hostName} (${quality})` });
            }
          });
        });
      }
      
      return candidates;
    })
    .then(candidates => {
      // Add standard on-page fallback matches if API returned too few links
      if (candidates.length === 0) {
        $('iframe, video source, embed').each((index, el) => {
          let url = $(el).attr('src') || $(el).attr('value') || $(el).attr('data-src') || '';
          if (url) {
            if (url.startsWith('//')) url = 'https:' + url;
            if (isStreamHost(url) && !urlSet.has(url)) {
              urlSet.add(url);
              candidates.push({ url, label: `Mirror ${index + 1}` });
            }
          }
        });
      }
      
      // Build final stream objects for Nuvio
      candidates.forEach(c => {
        if (!urlSet.has(c.url)) {
          urlSet.add(c.url);
          streams.push({
            name: 'Kuronime',
            title: `Kuronime | ${c.label}`,
            url: c.url,
            quality: c.label.includes('1080p') ? '1080p' : '720p',
            headers: {
              'Referer': refererUrl,
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
          });
        }
      });
      
      log(`Total resolved streams: ${streams.length}`);
      return streams;
    })
    .catch(err => {
      log(`API decryption lookup failed: ${err.message}. Falling back to standard DOM scraping.`);
      return parseDOMFallback($, refererUrl);
    });
  }
  
  return parseDOMFallback($, refererUrl);
}

function parseDOMFallback($, refererUrl) {
  const streams = [];
  const urlSet = new Set();
  
  $('iframe, video source, embed').each((index, el) => {
    let url = $(el).attr('src') || $(el).attr('value') || $(el).attr('data-src') || '';
    if (url) {
      if (url.startsWith('//')) url = 'https:' + url;
      if (isStreamHost(url) && !urlSet.has(url)) {
        urlSet.add(url);
        streams.push({
          name: 'Kuronime',
          title: `Kuronime | Mirror ${index + 1}`,
          url: url,
          quality: '720p',
          headers: {
            'Referer': refererUrl,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
      }
    }
  });
  
  log(`Fallback DOM resolved ${streams.length} streams.`);
  return Promise.resolve(streams);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
            }
