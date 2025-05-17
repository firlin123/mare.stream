XHR_TIMEOUT = 60000
XHR_MAX_AGE = 60000
XHR_ALERT_TIME = 3000

getXHR = (url, callback) ->
    xhr = new XMLHttpRequest()
    timeout = setTimeout (->
        callback error: true, errorKind: 'timeout'
        callback = (d) -> 
        xhr.abort()
    ), XHR_TIMEOUT
    xhr.onreadystatechange = ->
        if xhr.readyState is XMLHttpRequest.DONE
            clearTimeout(timeout)
            if xhr.status is 200
                try
                    callback error: false, json: JSON.parse(xhr.responseText)
                catch e
                    callback error: true, errorKind: 'json'
            else
                callback error: true, errorKind: 'http', status: xhr.status
    xhr.onerror = (err) ->
        callback error: true, errorKind: 'other', data: err
    xhr.open 'GET', url
    xhr.send()

tryCatch = (callback, args...) ->
    try
        callback(args...)
    catch err
        console.error err

getXHRWrapper = (url, resultCB, alertCB) ->
    now = Date.now()
    cache = getXHRWrapper.CACHE ?= {}
    if cache[url] && now - cache[url].time > XHR_MAX_AGE
        delete cache[url]
    if cache[url]
        if now - cache[url].time > XHR_MAX_AGE
            delete cache[url]
        else
            return resultCB cache[url].data
    inFlight = getXHRWrapper.IN_FLIGHT ?= {}
    if inFlight[url]
        if inFlight[url].alerted then tryCatch alertCB
        else inFlight[url].alerts.push alertCB
        inFlight[url].results.push resultCB
        return
    current = inFlight[url] = 
        alerted: false
        alerts: [alertCB]
        results: [resultCB]
    timeout = setTimeout (->
        current.alerted = true
        current.alerts.forEach tryCatch
    ), XHR_ALERT_TIME
    getXHR url, (data) ->
        clearTimeout timeout
        cache[url] = 
            data: data
            time: now
        current.results.forEach (result) -> tryCatch result, data
        delete inFlight[url]

window.getInvidiousApiUrl = ->
  invidiousApiUrl = new URL("https://vids.mare.stream/")
  if USEROPTS.invidious_instance
    try
      invidiousApiUrl = new URL(USEROPTS.invidious_instance)
    catch e
      try
        invidiousApiUrl = new URL('https://' + USEROPTS.invidious_instance)
      catch _
  
  invidiousApiUrl.protocol = 'https:' unless invidiousApiUrl.protocol == 'http:'
  return invidiousApiUrl


window.getInvidious = (data, callback) ->
    invidiousApiUrl = window.getInvidiousApiUrl()
    invidiousApiUrl.pathname = "/api/v1/videos/" + data.id
    invidiousApiUrl.search = "?fields=videoId,title,lengthSeconds,adaptiveFormats,formatStreams,captions"
    link = "<a href=\"#{invidiousApiUrl.protocol}//#{invidiousApiUrl.host}\" target=\"_blank\" rel=\"noopener noreferer\"><strong>#{invidiousApiUrl.host}</strong></a>"
    invidiousApiUrl.search += ",hlsUrl" unless data.seconds
    
    getXHRWrapper invidiousApiUrl, (data) ->
        if data.error
            error = switch data.errorKind
                when 'json' then "Failed to parse json"
                when 'http' then "HTTP #{data.status}"
                when 'timeout' then "Request timeout"
                else "Unknown error"
            alert = makeAlert("Error", "Error while loading video information from #{link} invidious instance: #{error}", "alert-danger").removeClass('col-md-12')
            $('<button/>').addClass('btn btn-default').text('Change invidious settings').on 'click', ->
                showUserOptions()
                $("a[href='#us-playback']").trigger "click"
            .appendTo alert.find('.alert')
            callback("alert", alert, true) if callback
            return
        result = {}
        if data.json.lengthSeconds and not data.json.hlsUrl
            # normal video
            convertVideoToInfo result, data
            callback("info", result.info, result.adaptiveInfo) if callback
        else
            # livestream
            # TODO: convertLiveToInfo(prefetchedInfo, data)

    , ->
        alert = makeAlert("Loading...", "Loading video information from #{link} invidious instance.", "alert-info").removeClass('col-md-12')
        $('<button/>').addClass('btn btn-default').text('Change invidious settings').on 'click', ->
            showUserOptions()
            $("a[href='#us-playback']").trigger "click"
        .appendTo alert.find('.alert')
        callback("alert", alert, false) if callback

getInfo = (info, adaptiveInfo) ->
    if USEROPTS.invidious_adaptive
        return adaptiveInfo if Object.keys(adaptiveInfo.direct).length
        return info
    else
        return info if Object.keys(info.direct).length
        return adaptiveInfo

hasAdaptivity = (info, adaptiveInfo) ->
    if Object.keys(adaptiveInfo.direct).length and Object.keys(info.direct).length
        return true
    else
        return false

convertVideoToInfo = (output, data) ->
    video = data.json
    directAdaptive = {}

    video.adaptiveFormats.filter((e) -> e.resolution).map((adaptiveFormat) ->
        {
            link: adaptiveFormat.url
            contentType: adaptiveFormat.type
            quality: parseInt(adaptiveFormat.resolution.slice(0, -1))
        }
    ).forEach (directElement) ->
        directAdaptive[directElement.quality] = [] unless directAdaptive[directElement.quality]
        directAdaptive[directElement.quality].push directElement

    direct = {}
    video.formatStreams.map((formatStream) ->
        {
            link: formatStream.url
            contentType: formatStream.type
            quality: parseInt(formatStream.resolution.slice(0, -1))
        }
    ).forEach (directElement) ->
        direct[directElement.quality] = [] unless direct[directElement.quality]
        direct[directElement.quality].push directElement

    audioTracks = video.adaptiveFormats.filter((adaptiveFormat) -> adaptiveFormat.type.slice(0, 5) == "audio").map((adaptiveFormat) ->
        codec = adaptiveFormat.encoding
        codec = "aac" if !codec && adaptiveFormat.type.slice(11, 23) == "codecs=\"mp4a"
        codec = "opus" if !codec && adaptiveFormat.type.slice(12, 24) == "codecs=\"opus"
        codec = 'unk' unless codec
        label = Math.round(adaptiveFormat.bitrate / 102.4) / 10 + "Kb/s @ " + Math.round(adaptiveFormat.audioSampleRate / 100) / 10 + "Khz (" + codec + ")"
        {
            kind: "main"
            label: label
            url: adaptiveFormat.url
        }
    )

    adaptiveInfo = {
        direct: directAdaptive
        audioTracks: audioTracks
    }
    info = {
        direct: direct
    }
    
    output.adaptiveInfo = adaptiveInfo
    output.info = info


waitUntilDefined(window, 'videojs', => 
    class AdaptivePlaybackButton extends window.videojs.getComponent('Button')
        constructor: (player, options) ->
            super(player, options)
            @on 'click', =>
                if @onClick 
                    @onClick()
            @updateIcon()

        setOnClick: (onClick) ->
            @onClick = onClick

        updateIcon: ->
            if USEROPTS.invidious_adaptive
                @el().classList.add("adaptive-icon-class")
                @el().classList.remove("non-adaptive-icon-class")
                @controlText('Non-Adaptive Playback')
            else
                @el().classList.remove("adaptive-icon-class")
                @el().classList.add("non-adaptive-icon-class")
                @controlText('Adaptive Playback')

    window.videojs.registerComponent('AdaptivePlaybackButton', AdaptivePlaybackButton)

    style = document.createElement 'style'
    style.textContent = """
        .adaptive-icon-class .vjs-icon-placeholder:before {
            content: 'N';
        }

        .non-adaptive-icon-class .vjs-icon-placeholder:before {
            content: 'A';
        }

        .non-adaptive-icon-class .vjs-icon-placeholder:before,
        .adaptive-icon-class .vjs-icon-placeholder:before {
            font-family: "Helvetica Neue",Helvetica,Arial,sans-serif;
            margin-top: 1px;
            font-weight: bold;
        }
    """
    document.head.append style
)

window.InvidiousPlayer = class InvidiousPlayer extends VideoJSPlayer
    constructor: (data) ->
        if not (this instanceof InvidiousPlayer)
            return new InvidiousPlayer(data)
        @data = data;
        @setupMeta(data, => super(@data))

    load: (data) ->
        @data = data;
        @setupMeta(data, => super(@data))
    
    setupButton: (data, info, adaptiveInfo) ->
        if @player and @player.controlBar and hasAdaptivity(info, adaptiveInfo)
            if not @player.controlBar.adaptivePlaybackButton
                fsIndex = @player.controlBar.children().indexOf(@player.controlBar.getChild('fullscreenToggle'))
                if fsIndex is -1
                    adaptivePlaybackButton = @player.controlBar.addChild('AdaptivePlaybackButton')
                    @player.controlBar.adaptivePlaybackButton = adaptivePlaybackButton
                else
                    adaptivePlaybackButton = @player.controlBar.addChild('AdaptivePlaybackButton', {}, fsIndex)
                    @player.controlBar.adaptivePlaybackButton = adaptivePlaybackButton

            @player.controlBar.adaptivePlaybackButton.setOnClick =>
                USEROPTS.invidious_adaptive = not USEROPTS.invidious_adaptive
                $("#us-invidious-adaptive").prop("checked", USEROPTS.invidious_adaptive)
                @data.meta = getInfo(info, adaptiveInfo)
                @load(@data)

    setupMeta: (data, callback) ->
        if(data.metaLoaded)
            @adaptive = USEROPTS.invidious_adaptive
            callback()
            @setupButton(data, data.metaLoaded.info, data.metaLoaded.adaptiveInfo)
            return

        @instance = window.getInvidiousApiUrl();
        window.getInvidious(data, (type, info, adaptiveInfo) =>
            if type is "alert"
                alert = info
                removeOld(alert);
            else
                @data.meta = getInfo(info, adaptiveInfo)
                @data.metaLoaded = 
                    info: info
                    adaptiveInfo: adaptiveInfo
                @adaptive = USEROPTS.invidious_adaptive           
                callback()
                @setupButton(@data, info, adaptiveInfo)
        )
    
    getData: () ->
        return @data
    
    getInstance: () -> 
        return @instance
    
    loaded: () ->
        if @data and @data.metaLoaded
            return true
        else
            return false

    hasAdaptivity: () ->
        if @data and @data.metaLoaded
            return hasAdaptivity(@data.metaLoaded.info, @data.metaLoaded.adaptiveInfo)
        else
            return null
    
    getAdaptive: () ->
        return @adaptive

    updateMetaAndReload: () ->
        if @data and @data.metaLoaded
            @data.meta = getInfo(@data.metaLoaded.info, @data.metaLoaded.adaptiveInfo)
            @load(@data)