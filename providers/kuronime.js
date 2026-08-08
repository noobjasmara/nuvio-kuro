const cheerio = require('cheerio-without-node-native');

const TMDB_API_KEY = "844132b4db1b13101217e57c1d1a8123";
const BASE_IP_1 = "http://154.203.162.226";
const BASE_IP_2 = "http://154.203.167.220";

function fetchTMDB(tmdbId, mediaType) {
    const url = "https://api.themoviedb.org/3/" + mediaType + "/" + tmdbId + "?api_key=" + TMDB_API_KEY;
    return fetch(url)
        .then(res => {
            if (!res.ok) throw new Error("TMDB HTTP error " + res.status);
            return res.json();
        });
}

function getSeasonName(seasons, seasonNum) {
    if (!seasons || !Array.isArray(seasons)) return "";
    for (let i = 0; i < seasons.length; i++) {
        if (seasons[i].season_number === seasonNum) {
            return seasons[i].name || "";
        }
    }
    return "";
}

function fetchKuronime(path) {
    const url1 = BASE_IP_1 + path;
    const url2 = BASE_IP_2 + path;
    
    return fetch(url1)
        .then(res => {
            if (!res.ok) throw new Error("Primary IP error " + res.status);
            return res.text();
        })
        .catch(err => {
            console.log("[Kuronime] Primary IP failed, trying fallback IP... (" + err.message + ")");
            return fetch(url2)
                .then(res => {
                    if (!res.ok) throw new Error("Fallback IP error " + res.status);
                    return res.text();
                });
        });
}

function searchKuronime(query, episodeNum) {
    const searchPath = "/?s=" + encodeURIComponent(query);
    console.log("[Kuronime] Querying: \"" + query + "\" -> " + searchPath);
    
    return fetchKuronime(searchPath)
        .then(html => {
            const $ = cheerio.load(html);
            let matchedLink = "";
            
            $('h4 a, h2 a, .post-title a').each((i, el) => {
                const title = $(el).text() || '';
                const href = $(el).attr('href') || '';
                
                console.log("[Kuronime] Search Result Candidate: \"" + title + "\" -> " + href);
                
                const titleLower = title.toLowerCase();
                const queryLower = query.toLowerCase();
                
                let containsKeywords = true;
                const keywords = queryLower.split(" ");
                for (let k = 0; k < keywords.length; k++) {
                    if (keywords[k].length > 2 && !titleLower.includes(keywords[k])) {
                        containsKeywords = false;
                        break;
                    }
                }
                
                if (containsKeywords) {
                    const epPattern = new RegExp(`(?:episode|eps|eps\\s+|episode\\s+|-ep-|-episode-|-eps-|/ep-|/episode-|/eps-|^|\\b)0*${episodeNum}(?:\\b|[^\\d]|$)`, 'i');
                    if (epPattern.test(titleLower)) {
                        matchedLink = href;
                        console.log("[Kuronime] Matched Direct Episode Post: " + title);
                        return false; 
                    }
                    
                    if (!matchedLink) {
                        matchedLink = href;
                    }
                }
            });
            
            if (matchedLink && (matchedLink.includes('/tv/') || matchedLink.includes('/anime/') || matchedLink.includes('/series/'))) {
                console.log("[Kuronime] Matched link is a Series page. Fetching series page to find Episode " + episodeNum);
                return fetchKuronime(matchedLink.replace(BASE_IP_1, "").replace(BASE_IP_2, ""))
                    .then(seriesHtml => {
                        const $series = cheerio.load(seriesHtml);
                        let episodeLink = "";
                        
                        $series('a').each((i, el) => {
                            const href = $series(el).attr('href') || '';
                            const text = $series(el).text() || '';
                            
                            const epPattern = new RegExp(`(?:episode|eps|eps\\s+|episode\\s+|-ep-|-episode-|-eps-|/ep-|/episode-|/eps-|^|\\b)0*${episodeNum}(?:\\b|[^\\d]|$)`, 'i');
                            if (epPattern.test(href) || epPattern.test(text)) {
                                episodeLink = href;
                                return false; 
                            }
                        });
                        
                        return episodeLink || matchedLink; 
                    });
            }
            
            return matchedLink;
        });
}

function resolveStream(url) {
    return new Promise((resolve) => {
        if (url.includes("sibnet.ru")) {
            console.log("[Kuronime] Resolving Sibnet Stream: " + url);
            fetch(url, { headers: { "Referer": BASE_IP_1 + "/" } })
                .then(res => res.text())
                .then(html => {
                    const fileMatch = html.match(/file\s*:\s*['"]([^'"]+\.mp4[^'"]*)['"]/);
                    if (fileMatch) {
                        let directUrl = fileMatch[1];
                        if (directUrl.startsWith('/')) {
                            directUrl = "https://video.sibnet.ru" + directUrl;
                        }
                        console.log("[Kuronime] Sibnet Resolved Success: " + directUrl);
                        resolve({
                            name: "Kuronime - Sibnet",
                            title: "Sibnet Stream",
                            url: directUrl,
                            quality: "720p",
                            headers: {
                                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                                "Referer": url
                            },
                            provider: "kuronime"
                        });
                    } else {
                        resolve(null);
                    }
                })
                .catch(() => resolve(null));
        } else if (url.includes("uqload")) {
            console.log("[Kuronime] Resolving Uqload Stream: " + url);
            fetch(url, { headers: { "Referer": BASE_IP_1 + "/" } })
                .then(res => res.text())
                .then(html => {
                    const sourceMatch = html.match(/sources\s*:\s*\[\s*["']([^"']+)["']/);
                    if (sourceMatch) {
                        const directUrl = sourceMatch[1];
                        console.log("[Kuronime] Uqload Resolved Success: " + directUrl);
                        resolve({
                            name: "Kuronime - Uqload",
                            title: "Uqload Stream",
                            url: directUrl,
                            quality: "1080p",
                            headers: {
                                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                                "Referer": "https://uqload.to/"
                            },
                            provider: "kuronime"
                        });
                    } else {
                        resolve(null);
                    }
                })
                .catch(() => resolve(null));
        } else {
            resolve(null);
        }
    });
}

function extractPlayers(episodeUrl) {
    const relativePath = episodeUrl.replace(BASE_IP_1, "").replace(BASE_IP_2, "");
    return fetchKuronime(relativePath)
        .then(html => {
            const $ = cheerio.load(html);
            const embedUrls = [];
            
            $('iframe').each((i, el) => {
                const src = $(el).attr('src') || '';
                if (src) {
                    if (src.startsWith('//')) {
                        embedUrls.push("https:" + src);
                    } else if (src.startsWith('/')) {
                        embedUrls.push(BASE_IP_1 + src);
                    } else {
                        embedUrls.push(src);
                    }
                }
            });
            
            $('[data-embed], [data-video], [data-src], [data-url], [data-link]').each((i, el) => {
                const src = $(el).attr('data-embed') || $(el).attr('data-video') || $(el).attr('data-src') || $(el).attr('data-url') || $(el).attr('data-link') || '';
                if (src) {
                    if (src.startsWith('//')) {
                        embedUrls.push("https:" + src);
                    } else if (src.startsWith('/')) {
                        embedUrls.push(BASE_IP_1 + src);
                    } else if (src.startsWith('http')) {
                        embedUrls.push(src);
                    }
                }
            });
            
            console.log("[Kuronime] Found Raw Player Embeds: " + JSON.stringify(embedUrls));
            
            const streams = [];
            const promises = [];
            
            for (let i = 0; i < embedUrls.length; i++) {
                const url = embedUrls[i];
                promises.push(
                    resolveStream(url)
                        .then(resolvedStream => {
                            if (resolvedStream) {
                                streams.push(resolvedStream);
                            }
                        })
                        .catch(err => {
                            console.log("[Kuronime] Error resolving stream for: " + url + " - " + err.message);
                        })
                );
            }
            
            return Promise.all(promises).then(() => {
                if (streams.length > 0) {
                    return streams;
                }
                
                const fallbackStreams = [];
                for (let i = 0; i < embedUrls.length; i++) {
                    const url = embedUrls[i];
                    if (url.includes("sibnet") || url.includes("uqload") || url.includes("voe") || url.includes("mp4upload")) {
                        fallbackStreams.push({
                            name: "Kuronime - Embed " + (i + 1),
                            title: "Server " + (i + 1) + " (Embed)",
                            url: url,
                            quality: "720p",
                            headers: {
                                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                                "Referer": BASE_IP_1 + "/"
                            },
                            provider: "kuronime"
                        });
                    }
                }
                return fallbackStreams;
            });
        });
}

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
    return new Promise((resolve) => {
        console.log("[Kuronime] Starting lookup for ID: " + tmdbId + " (" + mediaType + ") Season: " + seasonNum + " Episode: " + episodeNum);
        
        fetchTMDB(tmdbId, mediaType)
            .then(mediaData => {
                const showName = mediaData.name;
                const seasonName = getSeasonName(mediaData.seasons, seasonNum);
                
                console.log("[Kuronime] Resolved TMDB Show Name: " + showName + ", Season Name: " + seasonName);
                
                let query = showName;
                if (seasonName && !showName.toLowerCase().includes(seasonName.toLowerCase())) {
                    query += " " + seasonName;
                }
                
                const cleanQuery = query.replace(/[^\w\s-]/g, '').trim();
                
                return searchKuronime(cleanQuery, episodeNum)
                    .then(episodeUrl => {
                        if (!episodeUrl) {
                            console.log("[Kuronime] Specific search failed, falling back to show name search: " + showName);
                            return searchKuronime(showName.replace(/[^\w\s-]/g, '').trim(), episodeNum);
                        }
                        return episodeUrl;
                    });
            })
            .then(episodeUrl => {
                if (!episodeUrl) {
                    console.log("[Kuronime] No episode page found.");
                    resolve([]);
                    return;
                }
                
                console.log("[Kuronime] Found Episode Page: " + episodeUrl);
                
                return extractPlayers(episodeUrl)
                    .then(streams => {
                        console.log("[Kuronime] Found streams count: " + streams.length);
                        resolve(streams);
                    });
            })
            .catch(err => {
                console.log("[Kuronime] Pipeline failed: " + err.message);
                resolve([]); 
            });
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getStreams };
} else {
    global.getStreams = getStreams;
}