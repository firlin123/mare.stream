var monTimeoutMS = 0;
var monTimeout = null;
function triggerMonitorUpdate() {
    monTimeoutMS = 1000 + Math.random() * 5000; // Jiggle update time a little bit so they would not hit the server all at the same time
    monTimeout = setTimeout(triggerMonitorUpdate, monTimeoutMS);
    monitorPlaylist();
}
triggerMonitorUpdate();

var prefetched = {};
function monitorPlaylist() {
    if (!PLAYLIST) return;
    if (PLAYLIST.length <= 1) return;
    var currentIdx = findIndexByUID(PLAYLIST, PL_CURRENT);
    if (currentIdx === -1) return;
    var nextIdx = currentIdx + 1;
    if (nextIdx === PLAYLIST.length) { nextIdx = 0; }
    var nextItem = PLAYLIST[nextIdx];
    if (nextItem.media.type === "yt" && !USEROPTS.yt_classic_embed && nextItem.media.seconds) {
        var mediaLength = PLAYLIST[currentIdx].media.seconds;
        if (!mediaLength) return; //Livestreams. We cant know when they will end.
        if (!PLAYER || !PLAYER.getTime) return;
        PLAYER.getTime(function (time) {
            var timeLeft = mediaLength - time;
            if (timeLeft < 30) {
                if (!PLAYER || !PLAYER.isPaused) return;
                PLAYER.isPaused(function (paused) {
                    if(paused) return;
                    if (USEROPTS.yt_classic_embed) return;
                    var instanceURL = getInvidiousApiUrl();
                    var instanceStr = instanceURL.protocol + "//" + instanceURL.host;
                    if (!prefetched[instanceStr]) {
                        prefetched[instanceStr] = {};
                    }
                    var now = Date.now();
                    if (prefetched[instanceStr][nextItem.media.id] && now - prefetched[instanceStr][nextItem.media.id] > 60000) {
                        delete prefetched[instanceStr][nextItem.media.id];
                    }
                    if (!prefetched[instanceStr][nextItem.media.id]) {
                        prefetched[instanceStr][nextItem.media.id] = now
                        // Trigger media download so it would already be in the cache when player calls this function
                        getInvidious(nextItem.media, function (a, b, c) { });
                    }
                });
            }
        });
    }
}