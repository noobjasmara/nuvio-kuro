// Kuronime Provider for Nuvio (Production-Grade Promise-based)
const cheerio = require('cheerio-without-node-native');
const CryptoJS = require('crypto-js');

const PRIMARY_IP = '154.203.162.226';
const FALLBACK_IP = '154.203.167.220';
const TMDB_API_KEY = '844132b4db1b13101217e57c1d1a8123';

function log(msg) {
    console.log(`[Kuronime] ${msg}`);
}

function deriveKey(password, saltHex) {
    const passwordBytes = CryptoJS.enc.Utf8.parse(password);
    const saltBytes = CryptoJS.enc.Hex.parse(saltHex);
    let d1 = CryptoJS.MD5(passwordBytes.clone().concat(saltBytes));
    let d2 = CryptoJS.MD5(d1.clone().concat(passwordBytes).concat(saltBytes));
    return d1.concat(d2);
}

function decryptMirror(mirrorStr) {
    try {
        const wrapper = JSON.parse(atob(mirrorStr.trim()));
        const ct = CryptoJS.enc.Base64.parse(wrapper.ct);
        const iv = CryptoJS.enc.Hex.parse(wrapper.iv);
        
        const key = deriveKey("3&!Z0M,VIZ;dZW==", wrapper.s);
        
        const decrypted = CryptoJS.AES.decrypt(
            { ciphertext: ct },
            key,
            {
                iv: iv,
                mode: CryptoJS.mode.CBC,
                padding: CryptoJS.pad.Pkcs7
            }
        );
        return decrypted.toString(CryptoJS.enc.Utf8);
    } catch (e) {
        log(`Decryption error: ${e.message}`);
        return null;
    }
}

function parseMirrorAndExtract(decryptedText, streams, urlSet) {
    try {
        const json = JSON.parse(decryptedText);
        
        // 1. Process "embed"
        if (json.embed) {
            for (const quality of Object.keys(json.embed)) {
                const hosts = json.embed[quality];
                if (hosts && typeof hosts === 'object') {
                    for (const hostName of Object.keys(hosts)) {
                        const hostUrl = hosts[hostName];
                        if (hostUrl && typeof hostUrl === 'string' && hostUrl.trim()) {
                            const cleanUrl = hostUrl.trim().split('#')[0];
                            if (!urlSet.has(cleanUrl)) {
                                urlSet.add(cleanUrl);
                                streams.push({
                                    url: cleanUrl,
                                    label: `${hostName} (${quality})`
                                });
                            }
                        }
                    }
                }
            }
        }
        
        // 2. Process other direct fields if any
        const directFields = ['filelions', 'blog', 'raw'];
        for (const field of directFields) {
            if (json[field] && typeof json[field] === 'string' && json[field].trim() && json[field] !== 'null') {
                const cleanUrl = json[field].trim().split('#')[0];
                if (!urlSet.has(cleanUrl)) {
                    urlSet.add(cleanUrl);
                    streams.push({
                        url: cleanUrl,
                        label: field.toUpperCase()
                    });
                }
            }
        }
    } catch (e) {
        log(`Parse mirror error: ${e.message}`);
    }
}

function isDirectMedia(url) {
    const lower = url.toLowerCase();
    return lower.includes('.m3u8') || lower.includes('.mp4') || lower.includes('mime=video/mp4') || lower.includes('mime=video%2fmp4') || lower.includes('googlevideo') || lower.includes('bloggerusercontent') || lower.includes('blogspot.') || lower.includes('ok.ru') || lower.includes('pixeldrain') || lower.includes('solidfiles');
}

function getDomainName(url) {
    const match = url.match(/https?:\/\/([^\/]+)/i);
    return match ? match[1] : 'Direct';
}

function fetchSources(encryptedId, referer) {
    const payload = JSON.stringify({ id: encryptedId });
    return fetch("https://animeku.org/api/v9/sources", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Origin": "https://animeku.org",
            "Referer": referer,
            "Accept": "application/json, text/plain, */*",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        },
        body: payload
    })
    .then(res => {
        if (!res.ok) throw new Error(`Status ${res.status}`);
        return res.json();
    })
    .catch(err => {
        log(`fetchSources failed: ${err.message}`);
        return null;
    });
}

function fetchPageWithFallback(path) {
    const primaryUrl = `http://${PRIMARY_IP}${path}`;
    const fallbackUrl = `http://${FALLBACK_IP}${path}`;
    log(`Attempting fetch from: ${primaryUrl}`);
    return fetch(primaryUrl, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": `http://${PRIMARY_IP}/`
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
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": `http://${FALLBACK_IP}/`
            }
        })
        .then(res => {
            if (!res.ok) throw new Error(`Fallback Status ${res.status}`);
            return res.text();
        });
    });
}

function scrapeIframes(html, rawCandidates, urlSet) {
    const $ = cheerio.load(html);
    $('iframe, video, source, embed').each((i, el) => {
        let src = $(el).attr('src') || $(el).attr('value') || $(el).attr('data-src') || '';
        if (src) {
            if (src.startsWith('//')) src = 'https:' + src;
            if (src.startsWith('http') && !urlSet.has(src)) {
                urlSet.add(src);
                rawCandidates.push({
                    url: src,
                    label: $(el).text().trim() || `Player ${i + 1}`
                });
            }
        }
    });
}

function resolveAllCandidates(rawCandidates, referer) {
    const resolvedStreams = [];
    const promises = rawCandidates.map(c => {
        const url = c.url;
        if (isDirectMedia(url)) {
            resolvedStreams.push({
                name: `Kuronime | ${c.label}`,
                title: `Kuronime Stream - Direct\nSource: ${getDomainName(url)}`,
                url: url,
                quality: '720p',
                headers: {
                    'Referer': referer,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            return Promise.resolve();
        } else {
            log(`Inspecting nested player: ${url.substring(0, 50)}...`);
            return fetch(url, {
                headers: {
                    "Referer": referer,
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                }
            })
            .then(res => res.ok ? res.text() : "")
            .then(playerHtml => {
                const nestedCandidates = [];
                const urlSet = new Set();
                
                const regex = /https?:\/\/[^"'\s<>\\()]+(?:\.m3u8|\.mp4|(?:googlevideo|blogger|blogspot|bloggerusercontent)[^"'\s<>\\()]*)/gi;
                let match;
                while ((match = regex.exec(playerHtml)) !== null) {
                    const mediaUrl = match[0].replace(/[.,;:\)\}\\]+$/, '');
                    if (isDirectMedia(mediaUrl) && !urlSet.has(mediaUrl)) {
                        urlSet.add(mediaUrl);
                        nestedCandidates.push({ url: mediaUrl, label: "Direct HLS" });
                    }
                }
                
                const $ = cheerio.load(playerHtml);
                $('iframe, video, source, embed').each((i, el) => {
                    let src = $(el).attr('src') || $(el).attr('value') || $(el).attr('data-src') || '';
                    if (src) {
                        if (src.startsWith('//')) src = 'https:' + src;
                        if (isDirectMedia(src) && !urlSet.has(src)) {
                            urlSet.add(src);
                            nestedCandidates.push({ url: src, label: `Direct Mirror ${i + 1}` });
                        }
                    }
                });
                
                nestedCandidates.forEach(nc => {
                    resolvedStreams.push({
                        name: `Kuronime | ${c.label} - ${nc.label}`,
                        title: `Kuronime Stream - 720p\nSource: ${getDomainName(nc.url)}`,
                        url: nc.url,
                        quality: '720p',
                        headers: {
                            'Referer': url,
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                        }
                    });
                });
            })
            .catch(err => {
                log(`Failed to inspect player ${url.substring(0, 30)}: ${err.message}`);
            });
        }
    });
    
    return Promise.all(promises).then(() => {
        log(`Successfully resolved ${resolvedStreams.length} direct playable streams`);
        return resolvedStreams;
    });
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
            $('article, .post-item, .item, .bsx, .bs').each((index, el) => {
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
            const streams = [];
            const urlSet = new Set();
            const rawCandidates = [];
            
            const encryptedIdMatch = html.match(/var\s+_0xa100d42aa\s*=\s*"([^"]+)"/) || html.match(/var\s+_0xa100d42aa\s*=\\s*\"([^\"]+)\"/);
            
            if (encryptedIdMatch && encryptedIdMatch[1]) {
                const encryptedId = encryptedIdMatch[1];
                log("Found encrypted sources ID: " + encryptedId.substring(0, 15) + "...");
                
                return fetchSources(encryptedId, postUrl)
                    .then(sourcesJson => {
                        if (sourcesJson && sourcesJson.mirror) {
                            log("Successfully fetched sources JSON. Decrypting mirror payload...");
                            const decrypted = decryptMirror(sourcesJson.mirror);
                            if (decrypted) {
                                log("Mirror payload decrypted successfully!");
                                parseMirrorAndExtract(decrypted, rawCandidates, urlSet);
                            }
                        }
                        
                        if (rawCandidates.length === 0) {
                            log("API returned no mirrors. Falling back to iframe extraction...");
                            scrapeIframes(html, rawCandidates, urlSet);
                        }
                        
                        return resolveAllCandidates(rawCandidates, postUrl);
                    });
            } else {
                log("No encrypted sources ID found. Falling back to iframe extraction...");
                scrapeIframes(html, rawCandidates, urlSet);
                return resolveAllCandidates(rawCandidates, postUrl);
            }
        });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getStreams };
} else {
    global.getStreams = getStreams;
              }
