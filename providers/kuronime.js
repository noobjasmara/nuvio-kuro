let CryptoJS;
try {
    CryptoJS = require('crypto-js');
} catch (e) {
    if (typeof globalThis !== 'undefined' && globalThis.CryptoJS) {
        CryptoJS = globalThis.CryptoJS;
    } else if (typeof global !== 'undefined' && global.CryptoJS) {
        CryptoJS = global.CryptoJS;
    } else if (typeof window !== 'undefined' && window.CryptoJS) {
        CryptoJS = window.CryptoJS;
    }
}

const PROVIDER_NAME = "Kuronime";
const TMDB_API_KEY = "52aa52a747407b30ec02845ff6b14bfe";

function evpBytesToKey(passwordStr, saltHex, keyLengthBytes) {
    const passwordBytes = CryptoJS.enc.Utf8.parse(passwordStr);
    const saltBytes = CryptoJS.enc.Hex.parse(saltHex);
    
    let key = CryptoJS.lib.WordArray.create();
    let block = CryptoJS.lib.WordArray.create();
    
    const md5 = CryptoJS.algo.MD5;
    
    while (key.sigBytes < keyLengthBytes) {
        const hasher = md5.create();
        hasher.update(block);
        hasher.update(passwordBytes);
        hasher.update(saltBytes);
        block = hasher.finalize();
        key.concat(block);
    }
    
    key.sigBytes = keyLengthBytes;
    key.clamp();
    return key;
}

function decryptMirror(encodedMirror) {
    try {
        const outerDecoded = CryptoJS.enc.Utf8.stringify(CryptoJS.enc.Base64.parse(encodedMirror.trim()));
        const wrapper = JSON.parse(outerDecoded);
        
        const ct = wrapper.ct;
        const ivHex = wrapper.iv;
        const saltHex = wrapper.s;
        
        const key = evpBytesToKey("3&!Z0M,VIZ;dZW==", saltHex, 32);
        const iv = CryptoJS.enc.Hex.parse(ivHex);
        
        const decrypted = CryptoJS.AES.decrypt(
            CryptoJS.lib.CipherParams.create({
                ciphertext: CryptoJS.enc.Base64.parse(ct)
            }),
            key,
            {
                iv: iv,
                mode: CryptoJS.mode.CBC,
                padding: CryptoJS.pad.Pkcs7
            }
        );
        
        return decrypted.toString(CryptoJS.enc.Utf8);
    } catch (e) {
        console.log("[Kuronime] Gagal mendekripsi mirror: " + e.message);
        return null;
    }
}

async function getTMDBDetails(tmdbId, type) {
    const endpointType = (type === 'tv' || type === 'anime') ? 'tv' : 'movie';
    const url = `https://api.themoviedb.org/3/${endpointType}/${tmdbId}?api_key=${TMDB_API_KEY}`;
    try {
        const res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            return {
                title: endpointType === 'tv' ? data.name : data.title,
                original_title: endpointType === 'tv' ? data.original_name : data.original_title,
                year: endpointType === 'tv' ? (data.first_air_date ? data.first_air_date.split('-')[0] : '') : (data.release_date ? data.release_date.split('-')[0] : '')
            };
        }
    } catch (e) {
        console.log("[Kuronime] Error fetching TMDB details: " + e.message);
    }
    return null;
}

async function searchKuronime(query) {
    const searchUrl = `https://kuronime.sbs/?s=${encodeURIComponent(query)}`;
    try {
        const res = await fetch(searchUrl, {
            headers: { "Referer": "https://kuronime.sbs/" }
        });
        if (!res.ok) return [];
        const html = await res.text();
        
        const matches = [];
        const regex = /<article[^>]*class=["']bs["'][^>]*>([\s\S]*?)<\/article>/gi;
        let match;
        while ((match = regex.exec(html)) !== null) {
            const articleHtml = match[1];
            const hrefMatch = articleHtml.match(/href=["'](https?:\/\/[^"']+\/anime\/[^"']+)["']/i);
            const titleMatch = articleHtml.match(/title=["']([^"']+)["']/i) || articleHtml.match(/<h2>([^<]+)<\/h2>/i);
            if (hrefMatch && titleMatch) {
                matches.push({
                    url: hrefMatch[1],
                    title: titleMatch[1].replace(/&amp;/g, '&').trim()
                });
            }
        }
        return matches;
    } catch (e) {
        console.log("[Kuronime] Error searching Kuronime: " + e.message);
        return [];
    }
}

function findBestMatch(results, targetTitle, targetOriginalTitle, season, type) {
    if (!results || results.length === 0) return null;
    
    const clean = (str) => str ? str.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
    
    const cleanTarget = clean(targetTitle);
    const cleanTargetOrig = clean(targetOriginalTitle);
    const seasonStr = season ? "season " + season : "";
    const hasSeason = (str) => seasonStr ? str.toLowerCase().includes(seasonStr) : true;
    
    if (type === 'tv' && season > 1) {
        for (const res of results) {
            const cleanRes = clean(res.title);
            if (hasSeason(res.title)) {
                if (cleanRes.includes(cleanTarget) || cleanRes.includes(cleanTargetOrig)) {
                    return res.url;
                }
            }
        }
    }
    
    for (const res of results) {
        const cleanRes = clean(res.title);
        if (cleanRes.includes(cleanTarget) || cleanRes.includes(cleanTargetOrig)) {
            if (type === 'tv' && seasonStr) {
                if (hasSeason(res.title)) {
                    return res.url;
                }
            } else {
                return res.url;
            }
        }
    }
    
    return results[0].url;
}

async function getEpisodeUrl(animeUrl, episodeNumber, type) {
    try {
        const res = await fetch(animeUrl, {
            headers: { "Referer": "https://kuronime.sbs/" }
        });
        if (!res.ok) return null;
        const html = await res.text();
        
        const episodes = [];
        const regex = /<a[^>]+href=["'](https?:\/\/[^"']+\/nonton-[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        while ((match = regex.exec(html)) !== null) {
            const href = match[1];
            const text = match[2].replace(/<[^>]*>/g, '').trim();
            
            const epNumMatch = text.match(/Episode\s+(\d+(?:\.\d+)?)/i);
            const epNum = epNumMatch ? parseFloat(epNumMatch[1]) : null;
            if (epNum !== null) {
                episodes.push({ href, episode: epNum });
            }
        }
        
        if (episodes.length === 0) {
            return animeUrl;
        }
        
        const matchEp = episodes.find(ep => ep.episode === episodeNumber);
        if (matchEp) {
            return matchEp.href;
        }
        
        return episodes[0].href;
    } catch (e) {
        console.log("[Kuronime] Error getting episode URL: " + e.message);
        return null;
    }
}

async function getStreams(id, type, season, episode) {
    try {
        console.log(`[Kuronime] getStreams dipanggil: id=${id}, type=${type}, season=${season}, episode=${episode}`);
        
        const tmdb = await getTMDBDetails(id, type);
        if (!tmdb) return [];
        console.log(`[Kuronime] Terjemahan TMDB: ${tmdb.title} / ${tmdb.original_title}`);
        
        let results = [];
        const s = season || 1;
        
        if (type === 'tv' && s > 1) {
            results = await searchKuronime(`${tmdb.original_title} Season ${s}`);
            if (results.length === 0) {
                results = await searchKuronime(`${tmdb.title} Season ${s}`);
            }
        }
        
        if (results.length === 0) {
            results = await searchKuronime(tmdb.original_title);
        }
        if (results.length === 0) {
            results = await searchKuronime(tmdb.title);
        }
        
        if (results.length === 0) {
            console.log("[Kuronime] Hasil pencarian tidak ditemukan di Kuronime");
            return [];
        }
        
        const animeUrl = findBestMatch(results, tmdb.title, tmdb.original_title, s, type);
        if (!animeUrl) return [];
        console.log(`[Kuronime] Link anime Kuronime: ${animeUrl}`);
        
        const epNum = episode || 1;
        const episodeUrl = await getEpisodeUrl(animeUrl, epNum, type);
        if (!episodeUrl) return [];
        console.log(`[Kuronime] Link episode Kuronime: ${episodeUrl}`);
        
        const res = await fetch(episodeUrl, {
            headers: { "Referer": animeUrl }
        });
        if (!res.ok) return [];
        const html = await res.text();
        
        const encryptedIdMatch = html.match(/var\s+_0xa100d42aa\s*=\s*"([^"]+)"/);
        if (!encryptedIdMatch) {
            console.log("[Kuronime] Gagal menemukan encryptedId");
            return [];
        }
        const encryptedId = encryptedIdMatch[1];
        
        const apiResponse = await fetch("https://animeku.org/api/v9/sources", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Origin": "https://kuronime.sbs",
                "Referer": episodeUrl,
                "Accept": "application/json, text/plain, */*"
            },
            body: JSON.stringify({ id: encryptedId })
        });
        if (!apiResponse.ok) return [];
        const sourcesData = await apiResponse.json();
        
        const streams = [];
        
        if (sourcesData.src) {
            streams.push({
                name: "Kuronime Direct (HD)",
                quality: "1080p",
                title: `${tmdb.title} S${s}E${epNum}`,
                url: sourcesData.src,
                headers: { "Referer": "https://animeku.org/", "Origin": "https://kuronime.sbs" }
            });
        }
        if (sourcesData.src_sd) {
            streams.push({
                name: "Kuronime Direct (SD)",
                quality: "480p",
                title: `${tmdb.title} S${s}E${epNum}`,
                url: sourcesData.src_sd,
                headers: { "Referer": "https://animeku.org/", "Origin": "https://kuronime.sbs" }
            });
        }
        
        if (sourcesData.mirror) {
            const decryptedPayload = decryptMirror(sourcesData.mirror);
            if (decryptedPayload) {
                const mirror = JSON.parse(decryptedPayload);
                
                if (mirror.filelions) {
                    streams.push({
                        name: "Kuronime Filelions",
                        quality: "720p",
                        title: `${tmdb.title} S${s}E${epNum}`,
                        url: mirror.filelions,
                        headers: { "Referer": "https://animeku.org/" }
                    });
                }
                
                if (mirror.embed) {
                    for (const [quality, hosts] of Object.entries(mirror.embed)) {
                        for (const [hostName, hostUrl] of Object.entries(hosts)) {
                            if (hostUrl && hostUrl.trim().startsWith("http")) {
                                streams.push({
                                    name: `Kuronime ${hostName}`,
                                    quality: quality === "raw" ? "720p" : quality,
                                    title: `${tmdb.title} S${s}E${epNum}`,
                                    url: hostUrl.trim(),
                                    headers: { "Referer": "https://animeku.org/" }
                                });
                            }
                        }
                    }
                }
            }
        }
        
        return streams;
    } catch (e) {
        console.log("[Kuronime] Error di getStreams: " + e.message);
        return [];
    }
}

async function search(query) {
    return [];
}

async function getCatalog(catalogId, page) {
    return [];
}

async function getItemDetails(url) {
    return [];
}

typeof module !== "undefined" && module.exports ? (module.exports = {
    'getStreams': getStreams,
    'search': search,
    'getCatalog': getCatalog,
    'getItemDetails': getItemDetails
}) : (global.getStreams = getStreams);
          
