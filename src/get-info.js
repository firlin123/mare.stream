const https = require("https");
const Media = require("./media");
const CustomEmbedFilter = require("./customembed").filter;
const Config = require("./config");
const ffmpeg = require("./ffmpeg");
const mediaquery = require("@cytube/mediaquery");
const YouTube = require("@cytube/mediaquery/lib/provider/youtube");
const Invidious = require("@cytube/mediaquery/lib/provider/invidious");
const Vimeo = require("@cytube/mediaquery/lib/provider/vimeo");
const Odysee = require("@cytube/mediaquery/lib/provider/odysee");
const PeerTube = require("@cytube/mediaquery/lib/provider/peertube");
const BitChute = require("@cytube/mediaquery/lib/provider/bitchute");
const BandCamp = require("@cytube/mediaquery/lib/provider/bandcamp");
const Nicovideo = require("@cytube/mediaquery/lib/provider/nicovideo");
const Streamable = require("@cytube/mediaquery/lib/provider/streamable");
const TwitchVOD = require("@cytube/mediaquery/lib/provider/twitch-vod");
const TwitchClip = require("@cytube/mediaquery/lib/provider/twitch-clip");
import { Counter } from 'prom-client';
import { lookup as lookupCustomMetadata } from './custom-media';

const LOGGER = require('@calzoneman/jsli')('get-info');
const lookupCounter = new Counter({
    name: 'cytube_media_lookups_total',
    help: 'Count of media lookups',
    labelNames: ['shortCode']
});

var urlRetrieve = function (transport, options, callback) {
    var req = transport.request(options, function (res) {
        res.on("error", function (err) {
            LOGGER.error("HTTP response " + options.host + options.path + " failed: "+
                err);
            callback(503, "");
        });

        var buffer = "";
        res.setEncoding("utf-8");
        res.on("data", function (chunk) {
            buffer += chunk;
        });
        res.on("end", function () {
            callback(res.statusCode, buffer);
        });
    });

    req.on("error", function (err) {
        LOGGER.error("HTTP request " + options.host + options.path + " failed: " +
            err);
        callback(503, "");
    });

    req.end();
};

var mediaTypeMap = {
    "youtube": "yt",
    "googledrive": "gd",
    "google+": "gp"
};

function convertMedia(media) {
    return new Media(media.id, media.title, media.duration, mediaTypeMap[media.type],
            media.meta);
}

var Getters = {
    /* youtube.com */
    yt: function (id, callback) {
        var useInvidious = Config.get("youtube-use-invidious");
        if (!useInvidious && !Config.get("youtube-v3-key")) {
            return callback("The YouTube API now requires an API key.  Please see the " +
                            "documentation for youtube-v3-key in config.template.yaml");
        }


        (useInvidious ? Invidious : YouTube).lookup(id).then(function (video) {
            var meta = {};
            if (video.meta.blocked) {
                meta.restricted = video.meta.blocked;
            }
            if (video.meta.ytRating) {
                meta.ytRating = video.meta.ytRating;
            }

            var media = new Media(video.id, video.title, video.duration, "yt", meta);
            callback(false, media);
        }).catch(function (err) {
            callback(err.message || err, null);
        });
    },

    /* youtube.com playlists */
    yp: function (id, callback) {
        var useInvidious = Config.get("youtube-use-invidious");
        if (!useInvidious && !Config.get("youtube-v3-key")) {
            return callback("The YouTube API now requires an API key.  Please see the " +
                            "documentation for youtube-v3-key in config.template.yaml");
        }

        (useInvidious ? Invidious : YouTube).lookupPlaylist(id).then(function (videos) {
            videos = videos.map(function (video) {
                var meta = {};
                if (video.meta.blocked) {
                    meta.restricted = video.meta.blocked;
                }

                return new Media(video.id, video.title, video.duration, "yt", meta);
            });

            callback(null, videos);
        }).catch(function (err) {
            callback(err.message || err, null);
        });
    },

    /* youtube.com search */
    ytSearch: function (query, callback) {
        var useInvidious = Config.get("youtube-use-invidious");
        if (!useInvidious && !Config.get("youtube-v3-key")) {
            return callback("The YouTube API now requires an API key.  Please see the " +
                            "documentation for youtube-v3-key in config.template.yaml");
        }

        (useInvidious ? Invidious : YouTube).search(query).then(function (res) {
            var videos = res.results;
            videos = videos.map(function (video) {
                var meta = {};
                if (video.meta.blocked) {
                    meta.restricted = video.meta.blocked;
                }

                var media = new Media(video.id, video.title, video.duration, "yt", meta);
                media.thumb = { url: video.meta.thumbnail };
                return media;
            });

            callback(null, videos);
        }).catch(function (err) {
            callback(err.message || err, null);
        });
    },

    /* vimeo.com */
    vi: function (id, callback) {
        var m = id.match(/([\w-]+)/);
        if (m) {
            id = m[1];
        } else {
            callback("Invalid ID", null);
            return;
        }

        Vimeo.lookup(id).then(video => {
            video = new Media(video.id, video.title, video.duration, "vi");
            callback(null, video);
        }).catch(error => {
            callback(error.message);
        });
    },

    /* dailymotion.com */
    dm: function (id, callback) {
        var m = id.match(/([\w-]+)/);
        if (m) {
            id = m[1].split("_")[0];
        } else {
            callback("Invalid ID", null);
            return;
        }
        var options = {
            host: "api.dailymotion.com",
            port: 443,
            path: "/video/" + id + "?fields=duration,title",
            method: "GET",
            dataType: "jsonp",
            timeout: 1000
        };

        urlRetrieve(https, options, function (status, data) {
            switch (status) {
                case 200:
                    break; /* Request is OK, skip to handling data */
                case 400:
                    return callback("Invalid request", null);
                case 403:
                    return callback("Private video", null);
                case 404:
                    return callback("Video not found", null);
                case 500:
                case 503:
                    return callback("Service unavailable", null);
                default:
                    return callback("HTTP " + status, null);
            }

            try {
                data = JSON.parse(data);
                var title = data.title;
                var seconds = data.duration;
                /**
                 * This is a rather hacky way to indicate that a video has
                 * been deleted...
                 */
                if (title === "Deleted video" && seconds === 10) {
                    callback("Video not found", null);
                    return;
                }
                var media = new Media(id, title, seconds, "dm");
                callback(false, media);
            } catch(e) {
                callback(e, null);
            }
        });
    },

    /* soundcloud.com - see https://github.com/calzoneman/sync/issues/916 */
    sc: function (id, callback) {
        callback(
            "Soundcloud is not supported anymore due to requiring OAuth but not " +
            "accepting new API key registrations."
        );
    },

    /* livestream.com */
    li: function (id, callback) {
        if (!id.match(/^\d+;\d+$/)) {
            callback("Invalid ID", null);
            return;
        }

        var title = "Livestream.com";
        var media = new Media(id, title, "--:--", "li");
        callback(false, media);
    },

    /* twitch.tv */
    tw: function (id, callback) {
        var m = id.match(/([\w-]+)/);
        if (m) {
            id = m[1];
        } else {
            callback("Invalid ID", null);
            return;
        }
        var title = "Twitch.tv - " + id;
        var media = new Media(id, title, "--:--", "tw");
        callback(false, media);
    },

    /* twitch VOD */
    tv: function (id, callback) {
        var m = id.match(/([cv]\d+)/);
        if (m) {
            id = m[1];
        } else {
            process.nextTick(callback, "Invalid Twitch VOD ID");
            return;
        }

        TwitchVOD.lookup(id).then(video => {
            const media = new Media(video.id, video.title, video.duration,
                                    "tv", video.meta);
            process.nextTick(callback, false, media);
        }).catch(function (err) {
            callback(err.message || err, null);
        });
    },

    /* twitch clip */
    tc: function (id, callback) {
        var m = id.match(/^([A-Za-z]+)$/);
        if (m) {
            id = m[1];
        } else {
            process.nextTick(callback, "Invalid Twitch VOD ID");
            return;
        }

        TwitchClip.lookup(id).then(video => {
            const media = new Media(video.id, video.title, video.duration,
                                    "tc", video.meta);
            process.nextTick(callback, false, media);
        }).catch(function (err) {
            callback(err.message || err, null);
        });
    },

    /* rtmp stream */
    rt: function (id, callback) {
        var title = "Livestream";
        var media = new Media(id, title, "--:--", "rt");
        callback(false, media);
    },

    /* HLS stream */
    hl: function (id, callback) {
        if (!/^https/.test(id)) {
            callback(
                "HLS links must start with HTTPS due to browser security " +
                "policy.  See https://git.io/vpDLK for details."
            );
            return;
        }
        var title = "Livestream";
        var media = new Media(id, title, "--:--", "hl");
        callback(false, media);
    },

    /* custom embed */
    cu: function (id, callback) {
        var media;
        try {
            media = CustomEmbedFilter(id);
        } catch (e) {
            if (/invalid embed/i.test(e.message)) {
                return callback(e.message);
            } else {
                LOGGER.error(e.stack);
                return callback("Unknown error processing embed");
            }
        }
        callback(false, media);
    },

    /* google docs */
    gd: function (id, callback) {
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
            callback("Invalid ID: " + id);
            return;
        }

        var data = {
            type: "googledrive",
            kind: "single",
            id: id
        };

        mediaquery.lookup(data).then(function (video) {
            callback(null, convertMedia(video));
        }).catch(function (err) {
            callback(err.message || err);
        });
    },

    /* ffmpeg for raw files */
    fi: function (id, cb) {
        ffmpeg.query(id, function (err, data) {
            if (err) {
                return cb(err);
            }

            var m = new Media(id, data.title, data.duration, "fi", {
                bitrate: data.bitrate,
                codec: data.codec
            });
            cb(null, m);
        });
    },

    /* streamable */
    sb: function (id, callback) {
        if (!/^[\w-]+$/.test(id)) {
            process.nextTick(callback, "Invalid streamable.com ID");
            return;
        }

        Streamable.lookup(id).then(video => {
            const media = new Media(video.id, video.title, video.duration,
                                    "sb", video.meta);
            process.nextTick(callback, false, media);
        }).catch(function (err) {
            callback(err.message || err, null);
        });
    },

    /* PeerTube network */
    pt: function (id, callback) {
        PeerTube.lookup(id).then(video => {
            video = new Media(video.id, video.title, video.duration, "pt", video.meta);
            callback(null, video);
        }).catch(error => {
            callback(error.message || error);
        });
    },

    /* custom media - https://github.com/calzoneman/sync/issues/655 */
    cm: async function (id, callback) {
        try {
            const media = await lookupCustomMetadata(id);
            process.nextTick(callback, false, media);
        } catch (error) {
            process.nextTick(callback, error.message);
        }
    },

    /* BitChute */
    bc: function (id, callback) {
        BitChute.lookup(id).then(video => {
            video = new Media(video.id, video.title, video.duration, "bc", video.meta);
            callback(null, video);
        }).catch(error => {
            callback(error.message || error);
        });
    },

    /* Odysee */
    od: function (id, callback) {
        Odysee.lookup(id).then(video => {
            video = new Media(video.id, video.title, video.duration, "od", video.meta);
            callback(null, video);
        }).catch(error => {
            callback(error.message || error);
        });
    },

    /* BandCamp */
    bn: function (id, callback) {
        BandCamp.lookup(id).then(video => {
            video = new Media(video.id, video.title, video.duration, "bn", video.meta);
            callback(null, video);
        }).catch(error => {
            callback(error.message || error);
        });
    },

    /* Niconico */
    nv: function (id, callback) {
        Nicovideo.lookup(id).then(video => {
            video = new Media(video.id, video.title, video.duration, "nv", video.meta);
            callback(null, video);
        }).catch(error => {
            callback(error.message || error);
        });
    }
};

module.exports = {
    Getters: Getters,
    getMedia: function (id, type, callback) {
        if(type in this.Getters) {
            LOGGER.info("Looking up %s:%s", type, id);
            lookupCounter.labels(type).inc(1, new Date());
            this.Getters[type](id, callback);
        } else {
            callback("Unknown media type '" + type + "'", null);
        }
    }
};
