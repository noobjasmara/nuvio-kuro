const cheerio = require('cheerio-without-node-native');

function getStreams(tmdbId, mediaType, season, episode) {
  return new Promise((resolve, reject) => {
    console.log("[Kuronime] Starting lookup for ID: " + tmdbId + " (" + mediaType + ") Season: " + season + " Episode: " + episode);
    
    // 1. Fetch TMDB Details
    const tmdbUrl = mediaType === 'tv'
      ? 'https://api.themoviedb.org/3/tv/' + tmdbId + '?api_key=844132b4db1b13101217e57c1d1a8123'
      : 'https://api.themoviedb.org/3/movie/' + tmdbId + '?api_key=844132b4db1b13101217e57c1d1a8123';
      
    fetch(tmdbUrl)
      .then(res => {
        if (!res.ok) throw new Error("TMDB fetch failed");
        return res.json();
      })
      .then(tmdbData => {
        const query = tmdbData.name || tmdbData.title;
        if (!query) throw new Error("Could not resolve TMDB title");
        
        console.log("[Kuronime] Resolved TMDB Title: " + query);
        
        // Build clean query string
        let cleanQuery = query.toLowerCase();
        
        // 2. Try Primary IP
        return searchKuronime('http://154.203.167.220', cleanQuery, mediaType, season, episode)
          .catch(err => {
            console.log("[Kuronime] Primary IP failed (" + err.message + "), trying fallback IP...");
            return searchKuronime('http://154.203.162.226', cleanQuery, mediaType, season, episode);
          });
      })
      .then(streams => {
        console.log("[Kuronime] Lookup completed. Streams found: " + streams.length);
        resolve(streams);
      })
      .catch(err => {
        console.error("[Kuronime] Pipeline failed: " + err.message);
        resolve([]); // Resolve empty array on error to prevent Nuvio crash
      });
  });
}

function searchKuronime(baseIp, query, mediaType, season, episode) {
  return new Promise((resolve, reject) => {
    // Build search URL
    const searchUrl = baseIp + '/?s=' + encodeURIComponent(query);
    console.log("[Kuronime] Querying: " + searchUrl);
    
    fetch(searchUrl)
      .then(res => {
        if (!res.ok) throw new Error("Search fetch failed with status " + res.status);
        return res.text();
      })
      .then(html => {
        const $ = cheerio.load(html);
        let matchUrl = null;
        
        // Scan headings / links for titles
        $('h4 a, h2 a, h3 a, .entry-title a').each((i, el) => {
          const title = $(el).text().toLowerCase();
          const href = $(el).attr('href');
          
          if (href && !matchUrl) {
            // Match TV shows and movies
            if (mediaType === 'tv') {
              const hasShowName = title.includes(query);
              const epStr = 'episode ' + episode;
              const epStrZero = 'episode ' + (episode < 10 ? '0' + episode : episode);
              const epsStr = 'eps ' + episode;
              const epsStrZero = 'eps ' + (episode < 10 ? '0' + episode : episode);
              
              const hasEp = title.includes(epStr) || title.includes(epStrZero) || title.includes(epsStr) || title.includes(epsStrZero);
              
              if (hasShowName && hasEp) {
                matchUrl = href;
                console.log("[Kuronime] Match found: " + title + " -> " + matchUrl);
              }
            } else {
              if (title.includes(query)) {
                matchUrl = href;
                console.log("[Kuronime] Match found: " + title + " -> " + matchUrl);
              }
            }
          }
        });
        
        // If not found, try fallback search with "Episode" appended to see if direct episode post is indexed
        if (!matchUrl && mediaType === 'tv') {
          const directEpisodeQuery = query + ' Episode ' + episode;
          return fetch(baseIp + '/?s=' + encodeURIComponent(directEpisodeQuery))
            .then(res => res.text())
            .then(html2 => {
              const $2 = cheerio.load(html2);
              $2('h4 a, h2 a, h3 a, .entry-title a').each((i, el) => {
                const title = $2(el).text().toLowerCase();
                const href = $2(el).attr('href');
                if (href && !matchUrl && title.includes(query)) {
                  matchUrl = href;
                  console.log("[Kuronime] Direct Episode Match found: " + title + " -> " + matchUrl);
                }
              });
              
              if (!matchUrl) throw new Error("No matching post found on Kuronime");
              return extractStreamsFromPage(matchUrl);
            });
        }
        
        if (!matchUrl) throw new Error("No matching post found on Kuronime");
        return extractStreamsFromPage(matchUrl);
      })
      .then(streams => resolve(streams))
      .catch(err => reject(err));
  });
}

function extractStreamsFromPage(pageUrl) {
  return new Promise((resolve, reject) => {
    console.log("[Kuronime] Extracting streams from: " + pageUrl);
    
    fetch(pageUrl)
      .then(res => {
        if (!res.ok) throw new Error("Page fetch failed");
        return res.text();
      })
      .then(html => {
        const $ = cheerio.load(html);
        const streams = [];
        const seenUrls = new Set();
        
        // 1. Scan iframes
        $('iframe').each((i, el) => {
          let src = $(el).attr('src');
          if (src) {
            if (src.startsWith('//')) src = 'https:' + src;
            if (!seenUrls.has(src)) {
              seenUrls.add(src);
              let serverName = "Server " + (streams.length + 1);
              if (src.includes('sibnet')) serverName = "Sibnet";
              else if (src.includes('vidmoly')) serverName = "Vidmoly";
              else if (src.includes('uqload')) serverName = "Uqload";
              else if (src.includes('voe')) serverName = "Voe";
              
              streams.push({
                name: "Kuronime",
                title: serverName,
                url: src,
                quality: "720p",
                provider: "kuronime"
              });
            }
          }
        });
        
        // 2. Scan options / mirrors / embeds
        $('option, .server, .mirror, [data-embed], [data-video], [data-link]').each((i, el) => {
          const val = $(el).val() || $(el).attr('data-embed') || $(el).attr('data-video') || $(el).attr('data-link');
          const label = $(el).text().trim() || "Server " + (streams.length + 1);
          
          if (val && (val.includes('http') || val.startsWith('//'))) {
            let cleanVal = val.startsWith('//') ? 'https:' + val : val;
            if (!seenUrls.has(cleanVal)) {
              seenUrls.add(cleanVal);
              let serverName = label;
              if (cleanVal.includes('sibnet')) serverName = "Sibnet";
              else if (cleanVal.includes('vidmoly')) serverName = "Vidmoly";
              else if (cleanVal.includes('uqload')) serverName = "Uqload";
              else if (cleanVal.includes('voe')) serverName = "Voe";
              
              streams.push({
                name: "Kuronime",
                title: "Stream: " + serverName,
                url: cleanVal,
                quality: "720p",
                provider: "kuronime"
              });
            }
          }
        });
        
        // 3. Scan direct download/streaming links
        $('a').each((i, el) => {
          const href = $(el).attr('href');
          const text = $(el).text().trim().toLowerCase();
          
          if (href && (href.includes('.mp4') || href.includes('.mkv') || href.includes('.m3u8'))) {
            if (!seenUrls.has(href)) {
              seenUrls.add(href);
              streams.push({
                name: "Kuronime",
                title: "Direct Link (" + (text || "Mirrored") + ")",
                url: href,
                quality: "1080p",
                provider: "kuronime"
              });
            }
          }
        });
        
        resolve(streams);
      })
      .catch(err => reject(err));
  });
}

// React Native / Nuvio Native compatibility block
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
        }
