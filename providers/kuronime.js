// Provider Kuronime untuk Nuvio (Versi ES5 Murni Tanpa Async/Await agar Kompatibel dengan Hermes)

var primaryHost = "http://154.203.162.226";
var backupHost = "http://154.203.167.220";

function cleanTitle(str) {
  if (!str) return "";
  return str.toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveUrl(base, relative) {
  if (!relative) return "";
  if (relative.indexOf('http://') === 0 || relative.indexOf('https://') === 0 || relative.indexOf('//') === 0) {
    if (relative.indexOf('//') === 0) return "http:" + relative;
    return relative;
  }
  if (relative.indexOf('/') === 0) {
    var parts = base.split('/');
    return parts[0] + "//" + parts[2] + relative;
  }
  var dir = base.substring(0, base.lastIndexOf('/'));
  return dir + "/" + relative;
}

function resolveShowName(tmdbId, mediaType) {
  return new Promise(function(resolve) {
    if (typeof tmdbId === 'string' && tmdbId.indexOf('kitsu:') === 0) {
      var kitsuId = tmdbId.split(':')[1];
      var kitsuUrl = "https://kitsu.io/api/edge/anime/" + kitsuId;
      fetch(kitsuUrl)
        .then(function(res) { return res.json(); })
        .then(function(json) {
          if (json && json.data && json.data.attributes) {
            var title = json.data.attributes.canonicalTitle || json.data.attributes.titles.en || json.data.attributes.titles.en_jp || "";
            resolve({ title: title, isAnime: true });
          } else {
            resolve({ title: "Anime", isAnime: true });
          }
        })
        .catch(function() {
          resolve({ title: "Anime", isAnime: true });
        });
    } else {
      var apiKey = "844132b4db1b13101217e57c1d1a8123";
      var tmdbUrl = mediaType === "movie" 
        ? "https://api.themoviedb.org/3/movie/" + tmdbId + "?api_key=" + apiKey
        : "https://api.themoviedb.org/3/tv/" + tmdbId + "?api_key=" + apiKey;
      fetch(tmdbUrl)
        .then(function(res) { return res.json(); })
        .then(function(json) {
          if (json) {
            var title = mediaType === "movie" ? (json.title || json.original_title) : (json.name || json.original_name);
            resolve({ title: title, isAnime: false });
          } else {
            resolve({ title: "", isAnime: false });
          }
        })
        .catch(function() {
          resolve({ title: "", isAnime: false });
        });
    }
  });
}

function fetchKuronime(primaryHost, backupHost, path) {
  return new Promise(function(resolve, reject) {
    fetch(primaryHost + path)
      .then(function(res) {
        if (!res.ok) throw new Error("Status " + res.status);
        return res.text();
      })
      .then(resolve)
      .catch(function() {
        fetch(backupHost + path)
          .then(function(res) {
            if (!res.ok) throw new Error("Status " + res.status);
            return res.text();
          })
          .then(resolve)
          .catch(reject);
      });
  });
}

function extractStreamsFromHtml(html, primaryHost) {
  var cheerio = require('cheerio-without-node-native');
  var $ = cheerio.load(html);
  var streams = [];
  
  // 1. Ekstrak Iframe Embed
  $('iframe').each(function(i, el) {
    var src = $(el).attr('src');
    if (src) {
      var resolvedSrc = resolveUrl(primaryHost, src);
      var lowerSrc = resolvedSrc.toLowerCase();
      
      var hostName = "Embed Player";
      if (lowerSrc.indexOf('sibnet') !== -1) hostName = "Sibnet";
      else if (lowerSrc.indexOf('vidmoly') !== -1) hostName = "Vidmoly";
      else if (lowerSrc.indexOf('uqload') !== -1) hostName = "Uqload";
      else if (lowerSrc.indexOf('sendvid') !== -1) hostName = "Sendvid";
      else if (lowerSrc.indexOf('voe') !== -1) hostName = "Voe";
      else if (lowerSrc.indexOf('streamtape') !== -1) hostName = "Streamtape";
      else if (lowerSrc.indexOf('dood') !== -1) hostName = "Doodstream";
      else if (lowerSrc.indexOf('ok.ru') !== -1) hostName = "Ok.ru";
      else if (lowerSrc.indexOf('blogger') !== -1) hostName = "Blogger";
      
      streams.push({
        name: "Kuronime " + hostName,
        title: "Stream " + hostName,
        url: resolvedSrc,
        quality: "720p",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": primaryHost + "/"
        }
      });
    }
  });
  
  // 2. Ekstrak Link Download/Direct File
  $('a').each(function(i, el) {
    var href = $(el).attr('href');
    var text = $(el).text().trim();
    if (href) {
      var lowerHref = href.toLowerCase();
      var lowerText = text.toLowerCase();
      
      var isDirectFile = lowerHref.indexOf('.mp4') !== -1 || lowerHref.indexOf('.mkv') !== -1;
      var isFileHost = lowerHref.indexOf('drive.google.com') !== -1 || 
                       lowerHref.indexOf('mega.nz') !== -1 || 
                       lowerHref.indexOf('mediafire.com') !== -1 ||
                       lowerHref.indexOf('zippyshare') !== -1 ||
                       lowerHref.indexOf('gdrive') !== -1 ||
                       lowerHref.indexOf('blogger.com/video-play') !== -1;
                       
      if (isDirectFile || isFileHost) {
        var quality = "720p";
        if (lowerText.indexOf('1080') !== -1 || lowerHref.indexOf('1080') !== -1) quality = "1080p";
        else if (lowerText.indexOf('720') !== -1 || lowerHref.indexOf('720') !== -1) quality = "720p";
        else if (lowerText.indexOf('480') !== -1 || lowerHref.indexOf('480') !== -1) quality = "480p";
        else if (lowerText.indexOf('360') !== -1 || lowerHref.indexOf('360') !== -1) quality = "360p";
        
        var title = text || ("Server Direct " + quality);
        
        streams.push({
          name: "Kuronime " + (isDirectFile ? "Direct" : "Cloud"),
          title: title,
          url: href,
          quality: quality,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": primaryHost + "/"
          }
        });
      }
    }
  });
  
  return streams;
}

function fetchEpisodeOrSeriesPage(url, mediaType, episode, primaryHost, backupHost) {
  return new Promise(function(resolve, reject) {
    fetch(url)
      .then(function(res) {
        if (!res.ok) throw new Error("Status " + res.status);
        return res.text();
      })
      .then(function(html) {
        var cheerio = require('cheerio-without-node-native');
        var $ = cheerio.load(html);
        
        if (mediaType === "tv" && (url.indexOf('/tv/') !== -1 || url.indexOf('/anime/') !== -1)) {
          var episodeLinks = [];
          $('a').each(function(i, el) {
            var href = $(el).attr('href');
            var text = $(el).text().trim();
            if (href) {
              episodeLinks.push({ href: href, text: text });
            }
          });
          
          var targetEpisodeUrl = null;
          for (var i = 0; i < episodeLinks.length; i++) {
            var link = episodeLinks[i];
            var cleanedText = cleanTitle(link.text);
            var cleanedHref = link.href.toLowerCase();
            
            var isTargetEpisode = cleanedText.indexOf("episode " + episode) !== -1 || 
                                  cleanedText.indexOf("ep " + episode) !== -1 ||
                                  cleanedText.indexOf("eps " + episode) !== -1 ||
                                  cleanedHref.indexOf("episode-" + episode) !== -1 ||
                                  cleanedHref.indexOf("ep-" + episode) !== -1 ||
                                  cleanedText.match(new RegExp("\\b" + episode + "$"));
                                  
            if (isTargetEpisode) {
              targetEpisodeUrl = link.href;
              break;
            }
          }
          
          if (targetEpisodeUrl) {
            fetch(targetEpisodeUrl)
              .then(function(res2) { return res2.text(); })
              .then(function(html2) {
                var streams = extractStreamsFromHtml(html2, primaryHost);
                resolve(streams);
              })
              .catch(reject);
          } else {
            var streams = extractStreamsFromHtml(html, primaryHost);
            resolve(streams);
          }
        } else {
          var streams = extractStreamsFromHtml(html, primaryHost);
          resolve(streams);
        }
      })
      .catch(reject);
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  return new Promise(function(resolve) {
    resolveShowName(tmdbId, mediaType)
      .then(function(showInfo) {
        var showTitle = showInfo.title;
        if (!showTitle) {
          resolve([]);
          return;
        }
        
        var queries = [];
        if (mediaType === "tv") {
          queries.push(showTitle + " Episode " + episode);
          queries.push(showTitle + " Ep " + episode);
          queries.push(showTitle);
        } else {
          queries.push(showTitle);
        }
        
        function trySearch(index) {
          if (index >= queries.length) {
            resolve([]);
            return;
          }
          
          var query = queries[index];
          var path = "/?s=" + encodeURIComponent(query);
          
          fetchKuronime(primaryHost, backupHost, path)
            .then(function(html) {
              var cheerio = require('cheerio-without-node-native');
              var $ = cheerio.load(html);
              
              var links = [];
              $('a').each(function(i, el) {
                var href = $(el).attr('href');
                var text = $(el).text().trim();
                if (href && text && href.indexOf('http') === 0) {
                  links.push({ href: href, text: text });
                }
              });
              
              var matchedPostUrl = null;
              var cleanedQuery = cleanTitle(showTitle);
              
              for (var i = 0; i < links.length; i++) {
                var link = links[i];
                var cleanedText = cleanTitle(link.text);
                var cleanedHref = link.href.toLowerCase();
                
                if (mediaType === "tv") {
                  var hasEpisode = cleanedText.indexOf("episode " + episode) !== -1 || 
                                    cleanedText.indexOf("ep " + episode) !== -1 ||
                                    cleanedText.indexOf("eps " + episode) !== -1 ||
                                    cleanedHref.indexOf("episode-" + episode) !== -1 ||
                                    cleanedHref.indexOf("ep-" + episode) !== -1;
                                    
                  var matchesShow = cleanedText.indexOf(cleanedQuery) !== -1 || cleanedHref.indexOf(cleanedQuery.replace(/\s+/g, '-')) !== -1;
                  
                  if (hasEpisode && matchesShow) {
                    matchedPostUrl = link.href;
                    break;
                  }
                } else {
                  if (cleanedText.indexOf(cleanedQuery) !== -1 || cleanedHref.indexOf(cleanedQuery.replace(/\s+/g, '-')) !== -1) {
                    matchedPostUrl = link.href;
                    break;
                  }
                }
              }
              
              if (!matchedPostUrl && mediaType === "tv") {
                for (var i = 0; i < links.length; i++) {
                  var link = links[i];
                  var cleanedText = cleanTitle(link.text);
                  var cleanedHref = link.href.toLowerCase();
                  var matchesShow = cleanedText.indexOf(cleanedQuery) !== -1 || cleanedHref.indexOf(cleanedQuery.replace(/\s+/g, '-')) !== -1;
                  
                  var isSeriesPage = cleanedHref.indexOf('/tv/') !== -1 || cleanedHref.indexOf('/anime/') !== -1;
                  
                  if (matchesShow && isSeriesPage) {
                    matchedPostUrl = link.href;
                    break;
                  }
                }
              }
              
              if (matchedPostUrl) {
                fetchEpisodeOrSeriesPage(matchedPostUrl, mediaType, episode, primaryHost, backupHost)
                  .then(resolve)
                  .catch(function() {
                    trySearch(index + 1);
                  });
              } else {
                trySearch(index + 1);
              }
            })
            .catch(function() {
              trySearch(index + 1);
            });
        }
        
        trySearch(0);
      })
      .catch(function() {
        resolve([]);
      });
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}
