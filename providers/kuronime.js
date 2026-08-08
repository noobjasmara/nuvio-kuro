// providers/kuronime.js
const cheerio = require('cheerio-without-node-native');

const BASE_URL = "https://154.203.162.226"; // IP/Domain Kuronime Aktif
const TMDB_API_KEY = "8265bd1679663a7ea12ac168da84d2e8"; // Gowaru Active TMDB Key

/**
 * Memetakan Season + Episode TVDB/TMDB ke Absolute Episode menggunakan AniZip
 */
function getAbsoluteEpisode(tmdbId, season, episode) {
  if (!season || season === 1) return Promise.resolve(episode);

  const mapUrl = `https://api.ani.zip/v1/anime?tmdb_id=${tmdbId}`;
  return fetch(mapUrl)
    .then(res => res.ok ? res.json() : null)
    .then(data => {
      if (data && data.episodes) {
        for (const key in data.episodes) {
          const ep = data.episodes[key];
          if (ep.season === season && ep.episode === episode) {
            console.log(`[Kuronime] Mapped Season ${season} Ep ${episode} -> Absolute Ep ${ep.absoluteEpisodeNumber}`);
            return ep.absoluteEpisodeNumber || episode;
          }
        }
      }
      return episode;
    })
    .catch(() => episode); // Fallback ke episode biasa jika API mati
}

/**
 * Membuat alternatif nama seasonal agar cocok dengan judul postingan Kuronime
 */
function getAlternativeTitles(baseTitle, season) {
  if (!season || season === 1) return [baseTitle];
  const romanNumerals = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
  const roman = romanNumerals[season] || "";
  
  return [
    `${baseTitle} ${roman}`,
    `${baseTitle} Season ${season}`,
    `${baseTitle} S${season}`,
    baseTitle
  ];
}

/**
 * Mengambil judul asli anime dari Kitsu atau TMDB (Mendukung ID Kitsu format "kitsu:xxxx")
 */
function fetchMediaTitle(id, mediaType) {
  const idStr = String(id);
  
  // Jika Nuvio mengirimkan Kitsu ID (Sangat umum di katalog anime)
  if (idStr.includes('kitsu')) {
    const kitsuId = idStr.replace('kitsu:', '').trim();
    const kitsuUrl = `https://kitsu.io/api/edge/anime/${kitsuId}`;
    console.log(`[Kuronime] Kitsu ID dideteksi: ${kitsuId}. Mengambil metadata dari Kitsu...`);
    
    return fetch(kitsuUrl)
      .then(res => {
        if (!res.ok) throw new Error(`Kitsu API HTTP error! Status: ${res.status}`);
        return res.json();
      })
      .then(json => {
        const attrs = json?.data?.attributes;
        if (!attrs) throw new Error("Metadata kosong di Kitsu");
        
        // Cari judul yang paling cocok
        const title = attrs.canonicalTitle || attrs.titles?.en || attrs.titles?.en_jp || attrs.titles?.ja_jp;
        if (!title) throw new Error("Tidak menemukan judul di Kitsu");
        
        console.log(`[Kuronime] Kitsu berhasil resolve judul: "${title}"`);
        return title.replace(/[:\-–—()]/g, ' ').replace(/\s+/g, ' ').trim();
      })
      .catch(error => {
        console.error(`[Kuronime] Kitsu title resolution failed:`, error.message);
        return null;
      });
  }
  
  // Jika ID standard TMDB
  const type = mediaType === "tv" ? "tv" : "movie";
  const tmdbUrl = `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_API_KEY}`;
  
  return fetch(tmdbUrl)
    .then(res => {
      if (!res.ok) throw new Error(`TMDB HTTP status: ${res.status}`);
      return res.json();
    })
    .then(data => {
      const title = data.original_name || data.original_title || data.name || data.title;
      if (!title) throw new Error("Metadata kosong di TMDB");
      return title.replace(/[:\-–—()]/g, ' ').replace(/\s+/g, ' ').trim();
    })
    .catch(error => {
      console.error(`[Kuronime] TMDB title resolution failed:`, error.message);
      return null;
    });
}

/**
 * Fungsi Utama Resolver Nuvio (100% Hermes & Promise-compliant)
 */
function getStreams(tmdbId, mediaType, season, episode) {
  console.log(`[Kuronime] Memulai pencarian aliran video untuk ID: ${tmdbId}`);

  let resolvedTitle = "";
  let targetEpisode = episode;

  // 1. Dapatkan judul asli dari Kitsu/TMDB
  return fetchMediaTitle(tmdbId, mediaType)
    .then(title => {
      if (!title) return [];
      resolvedTitle = title;

      // 2. Petakan episode ke nomor absolute (Kitsu/AniZip) jika TV
      return getAbsoluteEpisode(tmdbId, season, episode);
    })
    .then(absoluteEp => {
      targetEpisode = absoluteEp;
      const searchTerms = getAlternativeTitles(resolvedTitle, season);
      
      // PERBAIKAN KRUSIAL: Ambil string pertama, bukan seluruh array!
      const primarySearchQuery = searchTerms[0]; 

      console.log(`[Kuronime] Melakukan pencarian kata kunci: "${primarySearchQuery}" | Target Episode: ${targetEpisode}`);
      const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(primarySearchQuery)}`;

      return fetch(searchUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
      });
    })
    .then(res => res.ok ? res.text() : "")
    .then(html => {
      if (!html) return [];
      const $ = cheerio.load(html);
      let animeUrl = null;

      // Cek variasi musiman pada hasil pencarian WordPress Muvipro
      const searchTerms = getAlternativeTitles(resolvedTitle, season);
      $('h4 a').each((index, element) => {
        const resultTitle = $(element).text().trim().toLowerCase();
        const href = $(element).attr('href');

        const isMatch = searchTerms.some(term => {
          const t = term.toLowerCase();
          return resultTitle.includes(t) || t.includes(resultTitle);
        });

        if (isMatch && href) {
          animeUrl = href;
          return false; // Break
        }
      });

      if (!animeUrl) {
        console.log(`[Kuronime] Tidak ada kecocokan pencarian di Kuronime untuk: "${resolvedTitle}"`);
        return [];
      }

      console.log(`[Kuronime] Ditemukan halaman anime: ${animeUrl}`);

      // 3. Masuk ke halaman anime dan cari daftar episodenya secara dinamis
      if (mediaType === "tv") {
        return fetch(animeUrl)
          .then(res => res.text())
          .then(mainHtml => {
            const $main = cheerio.load(mainHtml);
            let targetEpisodeUrl = null;

            // Cari link episode yang cocok dengan nomor target di halaman list
            $main('.muvipro-episode-list a, .episode-list a, .eps-list a, a').each((index, element) => {
              const linkText = $main(element).text().trim().toLowerCase();
              const href = $main(element).attr('href');

              const epsRegex = new RegExp(`\\b(eps|ep|episode|epsode)\\b\\s*${targetEpisode}/?\\b|\\b${targetEpisode}\\b`);
              if (epsRegex.test(linkText) && href && href.includes('episode')) {
                targetEpisodeUrl = href;
                return false; // Break
              }
            });

            // Jika daftar dinamis gagal, buat link slug fallback secara aman
            if (!targetEpisodeUrl) {
              const slug = animeUrl.replace(/\/$/, "").split("/").pop();
              targetEpisodeUrl = `${BASE_URL}/${slug}-episode-${targetEpisode}/`;
              console.log(`[Kuronime] Gagal mencocokkan list episode. Fallback URL: ${targetEpisodeUrl}`);
            } else {
              console.log(`[Kuronime] Ditemukan URL episode: ${targetEpisodeUrl}`);
            }

            return fetch(targetEpisodeUrl).then(res => res.text());
          });
      }

      return fetch(animeUrl).then(res => res.text());
    })
    .then(episodeHtml => {
      if (!episodeHtml) return [];
      const $ = cheerio.load(episodeHtml);
      const streams = [];

      // 4. Ekstrak player video dari iframe iframe Kuronime
      $('iframe, select option, source').each((index, element) => {
        let src = $(element).attr('src') || $(element).attr('value') || $(element).attr('data-src');
        if (src && (src.includes('m3u8') || src.includes('embed') || src.includes('player') || src.includes('stream'))) {
          if (src.startsWith('//')) src = 'https:' + src;

          streams.push({
            name: "Kuronime",
            title: `Server ${index + 1} (Sub Indo)`,
            url: src,
            quality: "720p",
            headers: {
              "Referer": BASE_URL,
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
            }
          });
        }
      });

      console.log(`[Kuronime] Berhasil menyelesaikan pencarian. Menemukan ${streams.length} sumber aliran video.`);
      return streams;
    })
    .catch(error => {
      console.error('[Kuronime] Scraper pipeline encountered an error:', error.message);
      return [];
    });
}

module.exports = { getStreams };