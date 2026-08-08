/*
 * Kuronime Provider for Nuvio (Promise-based, Hermes Compatible)
 * Built with exact selectors parsed from audit.js
 */

const cheerio = require('cheerio-without-node-native');
const CryptoJS = require('crypto-js');

const BASE_URL = 'https://154.203.167.220';
const MIRROR_PASSWORD = "3&!Z0M,VIZ;dZW==";

function hexToBytes(hex) {
  const bytes = [];
  for (let c = 0; c < hex.length; c += 2) {
    bytes.push(parseInt(hex.substr(c, 2), 16));
  }
  return bytes;
}

function evpBytesToKey(password, salt, keyLength) {
  const digest = CryptoJS.algo.MD5.create();
  const generated = [];
  let block = [];
  while (generated.length < keyLength) {
    digest.reset();
    if (block.length > 0) {
      const blockWords = CryptoJS.lib.WordArray.create(new Uint8Array(block));
      digest.update(blockWords);
    }
    const passWords = CryptoJS.lib.WordArray.create(new Uint8Array(password));
    const saltWords = CryptoJS.lib.WordArray.create(new Uint8Array(salt));
    digest.update(passWords);
    digest.update(saltWords);
    const hash = digest.finalize();
    
    const u8 = new Uint8Array(hash.sigBytes);
    for (let i = 0; i < hash.sigBytes; i++) {
      u8[i] = (hash.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
    }
    const hashBytes = Array.from(u8);
    generated.push(...hashBytes);
    block = hashBytes;
  }
  return generated.slice(0, keyLength);
}

function decryptAES(encryptedBase64, saltHex, ivHex) {
  try {
    const salt = hexToBytes(saltHex);
    const ivBytes = hexToBytes(ivHex);
    const passBytes = Array.from(new TextEncoder().encode(MIRROR_PASSWORD));
    
    const keyBytes = evpBytesToKey(passBytes, salt, 32);
    
    const key = CryptoJS.lib.WordArray.create(new Uint8Array(keyBytes));
    const iv = CryptoJS.lib.WordArray.create(new Uint8Array(ivBytes));
    const ciphertext = CryptoJS.enc.Base64.parse(encryptedBase64);
    
    const decrypted = CryptoJS.AES.decrypt(
      { ciphertext: ciphertext },
      key,
      { iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
    );
    
    return decrypted.toString(CryptoJS.enc.Utf8);
  } catch (e) {
    console.error("[Kuronime] Decryption error: " + e.message);
    return null;
  }
}

function getStreams(tmdbId, mediaType, season, episode) {
  return new Promise((resolve, reject) => {
    console.log("[Kuronime] Memulai pencarian TMDB ID: " + tmdbId);
    
    // 1. Ambil judul asli dari TMDB
    fetch("https://api.themoviedb.org/3/" + (mediaType === "tv" ? "tv" : "movie") + "/" + tmdbId + "?api_key=439c478a771f35c05022f9feabcca01c")
      .then(res => {
        if (!res.ok) throw new Error("TMDB API Error");
        return res.json();
      })
      .then(tmdbData => {
        const queryTitle = tmdbData.name || tmdbData.title;
        if (!queryTitle) throw new Error("Judul tidak ditemukan di TMDB");
        
        console.log("[Kuronime] Judul TMDB: " + queryTitle);
        const searchUrl = BASE_URL + "/?s=" + encodeURIComponent(queryTitle);
        
        // 2. Cari judul di Kuronime
        return fetch(searchUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
          }
        });
      })
      .then(res => res.text())
      .then(searchHtml => {
        const $ = cheerio.load(searchHtml);
        let animeUrl = null;
        
        // Berdasarkan audit: Struktur link search adalah div.item-article -> h2.entry-title -> a
        $("div.item-article h2.entry-title a, article.item-article h2 a, h2.entry-title a").each((i, el) => {
          const title = $(el).text() || $(el).attr("title") || "";
          if (title.toLowerCase().includes(queryTitle.toLowerCase()) || queryTitle.toLowerCase().includes(title.toLowerCase())) {
            animeUrl = $(el).attr("href");
            return false;
          }
        });
        
        if (!animeUrl) {
          // Fallback ke pencarian tautan pertama jika pencocokan nama ketat gagal
          animeUrl = $("div.item-article h2.entry-title a").first().attr("href");
        }
        
        if (!animeUrl) throw new Error("Anime tidak ditemukan di Kuronime");
        if (!animeUrl.startsWith("http")) {
          animeUrl = BASE_URL + animeUrl;
        }
        
        console.log("[Kuronime] Halaman Anime Detail: " + animeUrl);
        
        // 3. Ambil halaman detail untuk mencari episode
        return fetch(animeUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
          }
        });
      })
      .then(res => res.text())
      .then(detailHtml => {
        const $ = cheerio.load(detailHtml);
        let episodeUrl = null;
        
        if (mediaType === "movie") {
          // Jika movie, biasanya langsung mengarah ke halaman utama atau link list series pertama
          episodeUrl = $("div.gmr-listseries a").first().attr("href");
        } else {
          // Berdasarkan audit ffft.txt: Kontainer episode adalah div.gmr-listseries -> a
          // Dengan text: "Eps1", "Eps2", etc.
          const targetEpText = "Eps" + episode;
          console.log("[Kuronime] Mencari kontainer episode dengan text: " + targetEpText);
          
          $("div.gmr-listseries a").each((i, el) => {
            const epText = $(el).text().trim();
            // Cocokkan "Eps1" atau "Eps 1" atau "Eps01"
            if (epText.replace(/\s+/g, '').toLowerCase() === targetEpText.toLowerCase() || epText.includes(targetEpText)) {
              episodeUrl = $(el).attr("href");
              return false;
            }
          });
        }
        
        if (!episodeUrl) throw new Error("Episode " + episode + " tidak ditemukan di Kuronime");
        if (!episodeUrl.startsWith("http")) {
          episodeUrl = BASE_URL + episodeUrl;
        }
        
        console.log("[Kuronime] Halaman Nonton Episode: " + episodeUrl);
        
        // 4. Ambil halaman episode untuk mengekstrak ID Enkripsi
        return fetch(episodeUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
          }
        });
      })
      .then(res => res.text())
      .then(epHtml => {
        // Ekstrak _0xa100d42aa
        const idMatch = epHtml.match(/var\s+_0xa100d42aa\s*=\s*"([^"]+)"/);
        if (!idMatch) throw new Error("ID Enkripsi _0xa100d42aa tidak ditemukan");
        
        const encryptedId = idMatch[1];
        console.log("[Kuronime] Mendapatkan encrypted ID: " + encryptedId);
        
        // 5. Panggil server API Kuronime untuk mendapatkan link video
        return fetch("https://animeku.org/api/v9/sources", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Origin": "https://kuronime.sbs",
            "Referer": episodeUrl
          },
          body: JSON.stringify({ id: encryptedId })
        });
      })
      .then(res => res.json())
      .then(apiData => {
        if (!apiData || !apiData.mirror) throw new Error("API tidak mengembalikan data mirror");
        
        // 6. Dekripsi mirror payload
        const wrapper = JSON.parse(atob(apiData.mirror.trim()));
        const decryptedStr = decryptAES(wrapper.ct, wrapper.s, wrapper.iv);
        if (!decryptedStr) throw new Error("Gagal melakukan dekripsi payload AES");
        
        const mirrorData = JSON.parse(decryptedStr);
        const streams = [];
        
        // Ekstrak embed link
        if (mirrorData.embed) {
          Object.entries(mirrorData.embed).forEach(([quality, hosts]) => {
            Object.entries(hosts).forEach(([hostName, hostUrl]) => {
              if (hostUrl && hostUrl.startsWith("http")) {
                streams.push({
                  name: "Kuronime | " + hostName,
                  title: "Mirror " + hostName + " (" + quality + ")",
                  url: hostUrl,
                  quality: quality,
                  provider: "kuronime"
                });
              }
            });
          });
        }
        
        // Ekstrak direct filelions jika ada
        if (mirrorData.filelions && mirrorData.filelions.startsWith("http")) {
          streams.push({
            name: "Kuronime | FileLions",
            title: "Mirror FileLions (HD)",
            url: mirrorData.filelions,
            quality: "720p",
            provider: "kuronime"
          });
        }
        
        console.log("[Kuronime] Sukses mengekstrak " + streams.length + " streams.");
        resolve(streams);
      })
      .catch(err => {
        console.error("[Kuronime] Gagal memproses stream: " + err.message);
        resolve([]); // Mengembalikan array kosong agar Nuvio tidak crash
      });
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}
