;(function () {
  'use strict'

  if (window.__oStatsI18nLoaded) return
  window.__oStatsI18nLoaded = true

  var PLUGIN_VERSION = '1.0.0'
  var PLUGIN_ID = 'oStatsI18n'
  console.log('[oStatsI18n] O Stats I18n v' + PLUGIN_VERSION + ' loaded')

  // ==================== i18n ====================
  var _intlLocale = ''
  function tc(zh, en) {
    if (_intlLocale.indexOf('zh') === 0) return zh
    return en
  }
  function isZh() {
    return _intlLocale.indexOf('zh') === 0
  }

  ;(function initIntlBridge() {
    try {
      var api = window.PluginApi
      if (!api || !api.React || !api.patch || !api.libraries || !api.libraries.Intl) return
      var React = api.React
      function IntlBridge() {
        var intl = api.libraries.Intl.useIntl()
        React.useEffect(function () {
          _intlLocale = intl.locale || ''
        })
        return null
      }
      api.patch.before('App', function (props) {
        return [
          {
            children: React.createElement(
              React.Fragment,
              null,
              React.createElement(IntlBridge),
              props.children,
            ),
          },
        ]
      })
    } catch (e) {
      console.warn('[oStatsI18n] i18n bridge failed:', e)
    }
  })()

  // ===== Localized formatting helpers =====
  function fmtDateLocale() {
    return _intlLocale || 'en-US'
  }

  function formatLocalDate(dateStr) {
    const [year, month, day] = dateStr.split('-')
    return tc(`${year}年${month}月${day}日`, `${month}/${day}/${year}`)
  }

  function formatLocalDateShort(dateStr) {
    const [year, month, day] = dateStr.split('-')
    return tc(`${year}年${month}月${day}日`, `${month}/${day}/${year.slice(2)}`)
  }

  function formatShortDuration(seconds) {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    if (hours > 0) return tc(`${hours}时 ${minutes}分`, `${hours}h ${minutes}m`)
    if (minutes > 0) return tc(`${minutes}分`, `${minutes}m`)
    if (seconds > 0) return tc(`${Math.floor(seconds)}秒`, `${Math.floor(seconds)}s`)
    return tc('0分', '0m')
  }

  function formatHourLabel(hour) {
    if (isZh()) return `${hour}时`
    if (hour === 0 || hour === 24) return '12am'
    if (hour === 12) return '12pm'
    return hour < 12 ? `${hour}am` : `${hour - 12}pm`
  }

  function formatClockTime(hour, minute) {
    const mm = String(minute).padStart(2, '0')
    if (isZh()) return `${hour}:${mm}`
    let h = hour % 12
    h = h === 0 ? 12 : h
    const ampm = hour < 12 ? 'am' : 'pm'
    return `${h}:${mm}${ampm}`
  }

  // ===== UTILITY FUNCTIONS (Replaces CommunityScriptsUILibrary dependency) =====

  // GraphQL API call function
  async function callGQL(options) {
    const response = await fetch('/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: options.query,
        variables: options.variables || {},
      }),
    })

    if (!response.ok) {
      throw new Error(`GraphQL request failed: ${response.statusText}`)
    }

    const result = await response.json()
    if (result.errors) {
      console.error('[oStatsI18n] GraphQL errors:', result.errors)
      throw new Error(result.errors[0]?.message || 'GraphQL query failed')
    }

    return result.data
  }

  // ===== DATA CACHE HELPERS =====
  const SCENES_CORE_CACHE_KEY = 'oStatsI18n_scenes_core_v1'
  const SCENES_FULL_CACHE_KEY = 'oStatsI18n_scenes_full_v1'
  const STATS_CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes
  const STATS_USE_CACHE_KEY = 'oStatsI18n_use_cache'

  const inFlightDataRequests = {
    scenesCore: null,
    scenesFull: null,
  }

  function shouldUseCache() {
    try {
      const pref = localStorage.getItem(STATS_USE_CACHE_KEY)
      return pref === 'true'
    } catch (e) {
      return false
    }
  }

  function setShouldUseCache(value) {
    try {
      localStorage.setItem(STATS_USE_CACHE_KEY, value ? 'true' : 'false')
    } catch (e) {
      console.warn('[oStatsI18n] Failed to save cache preference:', e)
    }
  }

  function safeReadCache(cacheKey, maxAgeMs = STATS_CACHE_TTL_MS) {
    if (!shouldUseCache()) return null

    try {
      const raw = localStorage.getItem(cacheKey)
      if (!raw) return null

      const parsed = JSON.parse(raw)
      if (!parsed || !Array.isArray(parsed.data)) return null

      const age = Date.now() - (parsed.savedAt || 0)
      if (age > maxAgeMs) return null

      return parsed.data
    } catch (e) {
      console.warn('[oStatsI18n] Failed to read cache:', cacheKey, e)
      return null
    }
  }

  function safeWriteCache(cacheKey, data) {
    try {
      localStorage.setItem(
        cacheKey,
        JSON.stringify({
          savedAt: Date.now(),
          data,
        }),
      )
    } catch (e) {
      // Large payloads can exceed localStorage quota. This should not block rendering.
      console.warn('[oStatsI18n] Failed to write cache:', cacheKey, e)
    }
  }

  function sanitizeSceneForCache(scene, includePlayHistory) {
    return {
      id: scene.id,
      title: scene.title || null,
      o_counter: scene.o_counter || 0,
      o_history: Array.isArray(scene.o_history) ? scene.o_history : [],
      play_duration: scene.play_duration || 0,
      play_history:
        includePlayHistory && Array.isArray(scene.play_history)
          ? scene.play_history
          : [],
      files: [{ basename: scene.files?.[0]?.basename || '' }],
      paths: { screenshot: scene.paths?.screenshot || '' },
    }
  }

  async function fetchScenesData(includePlayHistory) {
    const playHistoryField = includePlayHistory ? 'play_history' : ''
    const query = `query {
      findScenes(scene_filter: {}, filter: { per_page: -1 }) {
        scenes {
          id
          title
          o_counter
          o_history
          play_duration
          ${playHistoryField}
          files {
            basename
          }
          paths {
            screenshot
          }
        }
      }
    }`

    const data = await callGQL({ query })
    const scenes = data.findScenes?.scenes || []
    return scenes.map((scene) =>
      sanitizeSceneForCache(scene, includePlayHistory),
    )
  }

  async function getScenesData(includePlayHistory = false, options = {}) {
    const { forceRefresh = false } = options
    const cacheKey = includePlayHistory
      ? SCENES_FULL_CACHE_KEY
      : SCENES_CORE_CACHE_KEY
    const inFlightKey = includePlayHistory ? 'scenesFull' : 'scenesCore'

    if (!forceRefresh) {
      const cached = safeReadCache(cacheKey)
      if (cached) {
        return cached
      }
    }

    if (inFlightDataRequests[inFlightKey]) {
      return inFlightDataRequests[inFlightKey]
    }

    inFlightDataRequests[inFlightKey] = fetchScenesData(includePlayHistory)
      .then((scenes) => {
        safeWriteCache(cacheKey, scenes)
        return scenes
      })
      .finally(() => {
        inFlightDataRequests[inFlightKey] = null
      })

    return inFlightDataRequests[inFlightKey]
  }

  async function getScenesWithOHistory(options = {}) {
    // Core data for top-level stats does not require play history.
    return getScenesData(false, options)
  }

  async function getScenesWithPlayHistory(options = {}) {
    return getScenesData(true, options)
  }

  // Path element listener - waits for specific page elements to load
  function PathElementListener(pathPattern, elementSelector, callback) {
    let lastPath = null
    let isProcessing = false

    const checkAndSetup = async () => {
      const currentPath = window.location.pathname

      // Check if we're on the right path
      if (!currentPath.includes(pathPattern)) {
        lastPath = currentPath
        return
      }

      // Check if path changed or first load
      if (currentPath === lastPath && isProcessing) {
        return
      }

      // Find the target element
      const element = document.querySelector(elementSelector)
      if (!element) {
        return
      }

      // Only run callback if path changed or first time
      if (currentPath !== lastPath || !isProcessing) {
        lastPath = currentPath
        isProcessing = true
        try {
          await callback(element)
        } finally {
          isProcessing = false
        }
      }
    }

    // Check on page load
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', checkAndSetup)
    } else {
      checkAndSetup()
    }

    // Watch for navigation changes (SPA routing)
    const observer = new MutationObserver(() => {
      checkAndSetup()
    })

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    })

    // Also listen for popstate (back/forward navigation)
    window.addEventListener('popstate', checkAndSetup)

    // Check periodically as fallback
    setInterval(checkAndSetup, 1000)
  }

  // ===== WATCH TIME TRACKING =====
  // This section tracks actual play time per day similar to Stash's track-activity plugin

  const TRACKING_INTERVAL = 10000 // Track every 10 seconds

  // In-memory cache of watch data
  let watchDataCache = null
  let watchDataLoaded = false
  let lastSaveTimestamp = 0 // Track when we last saved to detect stale data
  let isSaving = false // Prevent concurrent saves
  let pendingSavePromise = Promise.resolve() // Serialize in-flight save operations
  let saveDebounceTimer = null // Debounce timer for save operations
  let lastQueuedJobId = null // Track the most recent queued job ID

  let trackingIntervalId = null
  let trackingLastTickTime = 0
  const activeVideoElements = new Set()
  let currentSceneInfo = null // Track current scene being watched

  // Cross-tab communication via localStorage
  const STORAGE_KEY = 'oStatsI18n_watch_data_sync'
  const STORAGE_LOCK_KEY = 'oStatsI18n_save_lock'

  // Broadcast updated data to other tabs
  function broadcastUpdate(data) {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          data: data,
          timestamp: Date.now(),
          tab: Math.random(), // Identify this tab
        }),
      )
    } catch (e) {
      console.warn('[oStatsI18n] Failed to broadcast update:', e)
    }
  }

  // Listen for updates from other tabs
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY && e.newValue) {
      try {
        const update = JSON.parse(e.newValue)
        const today = getTodayDate()

        // Only update cache if the broadcast has newer data for today
        if (update.data && update.data[today]) {
          if (
            !watchDataCache ||
            (watchDataCache[today] || 0) < update.data[today]
          ) {
            console.log(
              '[oStatsI18n] Received update from another tab, syncing cache',
            )
            watchDataCache = update.data
            watchDataLoaded = true
            lastSaveTimestamp = update.timestamp
          }
        }
      } catch (e) {
        console.warn('[oStatsI18n] Failed to parse storage update:', e)
      }
    }
  })

  // Get today's date in YYYY-MM-DD format
  function getTodayDate() {
    const now = new Date()
    return getLocalDateString(now) // YYYY-MM-DD format
  }

  // Extract scene info from current page
  function getCurrentSceneInfo() {
    const path = window.location.pathname
    const match = path.match(/\/scenes\/(\d+)/)
    if (!match) return null

    const sceneId = match[1]

    // Try multiple methods to get title
    let title = null

    // Method 1: Try h2 in the scene page
    const h2Element = document.querySelector(
      '.scene-header h2, h2.scene-header__title, h2',
    )
    if (h2Element) {
      title = h2Element.textContent.trim()
    }

    // Method 2: Try title tag and strip " | Scenes | Stash"
    if (!title || title === '') {
      const titleTag = document.title
      if (titleTag && titleTag !== 'Stash') {
        // Split by pipe and take first part
        title = titleTag.split('|')[0].trim()
      }
    }

    // Fallback
    if (!title || title === '') {
      title = tc(`场景 ${sceneId}`, `Scene ${sceneId}`)
    }

    return { id: sceneId, title: title }
  }

  // Load watch time data from Stash configuration (syncs across devices)
  async function loadWatchTimeData() {
    // Return cached data if already loaded
    if (watchDataLoaded && watchDataCache !== null) {
      console.log('[oStatsI18n] Returning cached data')
      return watchDataCache
    }

    try {
      // Load data directly from the JSON file via HTTP
      // Add timestamp to prevent browser caching of stale data
      const url = `/plugin/${PLUGIN_ID}/assets/watch_data.json?t=${Date.now()}`
      console.log('[oStatsI18n] Fetching from:', url)
      const response = await fetch(url, {
        cache: 'no-store', // Force bypass of browser cache
        headers: {
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        },
      })
      console.log(
        '[oStatsI18n] Response status:',
        response.status,
        response.statusText,
      )

      if (response.ok) {
        const watchData = await response.json()

        // CRITICAL: Only update cache if loaded data is newer or equal
        // Check if we have cached data with more recent information
        if (watchDataCache && Object.keys(watchDataCache).length > 0) {
          const today = getTodayDate()
          // Simple format: just numbers
          const cachedTodayTime = watchDataCache[today] || 0
          const loadedTodayTime = watchData[today] || 0

          // If cached data has more watch time for today, keep it (it's fresher)
          if (cachedTodayTime > loadedTodayTime) {
            console.warn(
              `[oStatsI18n] Loaded data appears stale (${loadedTodayTime}s < ${cachedTodayTime}s cached). Keeping cached data.`,
            )
            watchDataLoaded = true
            return watchDataCache
          }
        }

        watchDataCache = watchData
        watchDataLoaded = true
        console.log(
          '[oStatsI18n] Loaded watch history from JSON file, total days:',
          Object.keys(watchData).length,
        )
        return watchDataCache
      } else if (response.status === 404) {
        // Only cache empty data on 404 if we don't have existing cache
        if (watchDataCache && Object.keys(watchDataCache).length > 0) {
          console.warn(
            '[oStatsI18n] File not found but have cached data, keeping cache',
          )
          watchDataLoaded = true
          return watchDataCache
        }
        console.log('[oStatsI18n] No watch history file found, starting fresh')
        watchDataCache = {}
        watchDataLoaded = true
        return watchDataCache
      } else {
        console.error('[oStatsI18n] Failed to load watch history:', response.status)
        // Return cached data if available, even if stale
        if (watchDataCache !== null) {
          console.warn('[oStatsI18n] Using cached data due to load failure')
          return watchDataCache
        }
      }
    } catch (e) {
      console.error('[oStatsI18n] Error loading watch history:', e)
      // Return cached data if available, even if stale
      if (watchDataCache !== null) {
        console.warn('[oStatsI18n] Using cached data due to error')
        return watchDataCache
      }
    }

    // Only reach here if load failed AND no cache exists
    // This is dangerous - don't cache this empty state
    console.error(
      '[oStatsI18n] Failed to load watch history and no cache available - using empty data (NOT cached)',
    )
    return {}
  }

  // Save watch time data to JSON file via Python task
  async function saveWatchTimeData(data) {
    // Safety check: don't save empty data if we have cached data
    if (
      Object.keys(data).length === 0 &&
      watchDataCache &&
      Object.keys(watchDataCache).length > 0
    ) {
      console.error(
        '[oStatsI18n] Refusing to save empty data - cached data exists!',
      )
      return
    }

    // Clear any existing debounce timer
    if (saveDebounceTimer) {
      clearTimeout(saveDebounceTimer)
    }

    // Debounce: only actually save after 2 seconds of no new save requests
    saveDebounceTimer = setTimeout(async () => {
      saveDebounceTimer = null

      // Check if another tab already has a save queued with the same or newer data
      try {
        const lockInfo = localStorage.getItem(STORAGE_LOCK_KEY)
        if (lockInfo) {
          const lock = JSON.parse(lockInfo)
          const today = getTodayDate()
          // If another tab queued a save within last 5 seconds with same/better data, skip
          if (
            Date.now() - lock.timestamp < 5000 &&
            lock.data[today] >= data[today]
          ) {
            console.log(
              '[oStatsI18n] Another tab already queued save with current data, skipping',
            )
            return
          }
        }
      } catch (e) {
        console.warn('[oStatsI18n] Failed to check save lock:', e)
      }

      // Set lock to indicate we're saving
      try {
        localStorage.setItem(
          STORAGE_LOCK_KEY,
          JSON.stringify({
            timestamp: Date.now(),
            data: data,
          }),
        )
      } catch (e) {
        console.warn('[oStatsI18n] Failed to set save lock:', e)
      }

      // If we previously queued a task, try to cancel it
      if (lastQueuedJobId) {
        console.log(
          '[oStatsI18n] Attempting to cancel previous save task:',
          lastQueuedJobId,
        )
        try {
          await callGQL({
            query: `mutation StopJob($job_id: ID!) {
              stopJob(job_id: $job_id)
            }`,
            variables: {
              job_id: lastQueuedJobId,
            },
          })
          console.log('[oStatsI18n] Canceled old save task')
        } catch (e) {
          // Task might have already started/completed, that's fine
          console.log(
            '[oStatsI18n] Could not cancel task (might be running):',
            e.message,
          )
        }
        lastQueuedJobId = null
      }

      isSaving = true
      try {
        const today = getTodayDate()
        const todaysTotal = data[today] || 0
        console.log('[oStatsI18n] Queueing save task, todays total:', todaysTotal)

        const result = await callGQL({
          query: `mutation RunPluginTask($plugin_id: ID!, $task_name: String!, $args_map: Map) {
            runPluginTask(plugin_id: $plugin_id, task_name: $task_name, args_map: $args_map)
          }`,
          variables: {
            plugin_id: PLUGIN_ID,
            task_name: 'saveWatchData',
            args_map: {
              watch_data: JSON.stringify(data),
            },
          },
        })

        // Store the job ID if available (runPluginTask returns the job ID)
        if (result.runPluginTask) {
          lastQueuedJobId = result.runPluginTask
          console.log('[oStatsI18n] Save task queued with ID:', lastQueuedJobId)
        }

        // Update cache after queuing task
        watchDataCache = data
        watchDataLoaded = true
        lastSaveTimestamp = Date.now()

        // Broadcast to other tabs that save was queued
        broadcastUpdate(data)

        console.log('[oStatsI18n] Watch history save task queued')
      } catch (e) {
        console.error('[oStatsI18n] Error queueing save task:', e)
      } finally {
        isSaving = false
      }
    }, 2000) // 2 second debounce
  }

  // Add watch time for today (simplified - just total time)
  async function addWatchTime(seconds, sceneInfo) {
    const today = getTodayDate()

    // Check for updates from other tabs via localStorage
    try {
      const storedUpdate = localStorage.getItem(STORAGE_KEY)
      if (storedUpdate) {
        const update = JSON.parse(storedUpdate)
        // Merge with other tabs' data - use the maximum value for today
        if (update.data && update.data[today]) {
          if (
            !watchDataCache ||
            (watchDataCache[today] || 0) < update.data[today]
          ) {
            console.log('[oStatsI18n] Merging data from another tab before update')
            watchDataCache = update.data
            watchDataLoaded = true
            lastSaveTimestamp = update.timestamp
          }
        }
      }
    } catch (e) {
      console.warn('[oStatsI18n] Failed to check localStorage for updates:', e)
    }

    // Use cached data if available
    const cacheAge = Date.now() - lastSaveTimestamp
    if (!watchDataCache || cacheAge > 60000) {
      console.log('[oStatsI18n] Cache stale or missing, reloading from disk')
      watchDataLoaded = false
      watchDataCache = null
    }

    const data = await loadWatchTimeData()

    // Safety check: if data is empty and we don't have cache loaded, something went wrong
    if (Object.keys(data).length === 0 && !watchDataLoaded) {
      console.error(
        '[oStatsI18n] Cannot add watch time - data load failed and no cache available. Skipping to prevent data loss.',
      )
      return
    }

    // Create a deep copy to avoid mutating the cache directly
    const dataCopy = JSON.parse(JSON.stringify(data))

    // Migrate old format to simple format if needed
    if (
      dataCopy[today] &&
      typeof dataCopy[today] === 'object' &&
      'totalTime' in dataCopy[today]
    ) {
      // Old format with videos array - extract just the total time
      dataCopy[today] = dataCopy[today].totalTime || 0
    }

    // Initialize today's time if it doesn't exist
    if (!dataCopy[today]) {
      dataCopy[today] = 0
    }

    // Update total time (simple format - just a number)
    dataCopy[today] += seconds

    // Broadcast update to other tabs
    broadcastUpdate(dataCopy)

    await saveWatchTimeData(dataCopy)
  }

  function queueWatchTimeSave(seconds) {
    if (seconds <= 0) return pendingSavePromise

    const sceneLog = currentSceneInfo ? ` (${currentSceneInfo.title})` : ''
    pendingSavePromise = pendingSavePromise
      .then(() => addWatchTime(seconds, currentSceneInfo))
      .then(() => {
        console.log(
          `[oStatsI18n] Saved ${seconds}s watch time for ${getTodayDate()}${sceneLog}`,
        )
      })
      .catch((err) => {
        console.error('[oStatsI18n] Failed queued watch time save:', err)
      })

    return pendingSavePromise
  }

  function flushTrackedWatchTime() {
    if (activeVideoElements.size === 0) {
      trackingLastTickTime = Date.now()
      return 0
    }

    const now = Date.now()
    if (!trackingLastTickTime) {
      trackingLastTickTime = now
      return 0
    }

    const elapsedSeconds = Math.floor((now - trackingLastTickTime) / 1000)
    if (elapsedSeconds <= 0) {
      return 0
    }

    trackingLastTickTime += elapsedSeconds * 1000
    const totalSeconds = elapsedSeconds * activeVideoElements.size
    queueWatchTimeSave(totalSeconds)
    return totalSeconds
  }

  function ensureTrackingInterval() {
    if (trackingIntervalId) return

    trackingLastTickTime = Date.now()
    trackingIntervalId = setInterval(() => {
      flushTrackedWatchTime()
    }, TRACKING_INTERVAL)
  }

  // Start tracking watch time for a specific video element.
  function startWatchTimeTracking(videoElement) {
    if (videoElement && activeVideoElements.has(videoElement)) {
      return
    }

    flushTrackedWatchTime()

    if (videoElement) {
      activeVideoElements.add(videoElement)
    }

    if (!currentSceneInfo) {
      currentSceneInfo = getCurrentSceneInfo()
    }

    ensureTrackingInterval()
    console.log(
      '[oStatsI18n] Active video trackers:',
      activeVideoElements.size,
      currentSceneInfo ? `(${currentSceneInfo.title})` : '',
    )
  }

  // Stop tracking watch time for a specific video element.
  async function stopWatchTimeTracking(videoElement) {
    flushTrackedWatchTime()

    if (videoElement) {
      activeVideoElements.delete(videoElement)
    } else {
      activeVideoElements.clear()
    }

    if (activeVideoElements.size > 0) {
      trackingLastTickTime = Date.now()
      console.log('[oStatsI18n] Active video trackers:', activeVideoElements.size)
      return
    }

    if (trackingIntervalId) {
      clearInterval(trackingIntervalId)
      trackingIntervalId = null
    }

    trackingLastTickTime = 0
    await pendingSavePromise
    currentSceneInfo = null
    console.log('[oStatsI18n] Stopped watch time tracking')
  }

  async function stopAllWatchTimeTracking() {
    await stopWatchTimeTracking(null)
  }

  // Check if we're currently on a scene page
  function isOnScenePage() {
    return /\/scenes\/\d+/.test(window.location.pathname)
  }

  // Hook into video player events
  function setupVideoPlayerTracking() {
    function attachTrackingToVideo(videoPlayer) {
      if (!videoPlayer || videoPlayer.dataset.oStatsI18nTracking) return

      videoPlayer.dataset.oStatsI18nTracking = 'true'

      videoPlayer.addEventListener('playing', () => {
        console.log('[oStatsI18n] Video playing')
        startWatchTimeTracking(videoPlayer)
      })

      videoPlayer.addEventListener('pause', async () => {
        console.log('[oStatsI18n] Video paused')
        await stopWatchTimeTracking(videoPlayer)
      })

      videoPlayer.addEventListener('ended', async () => {
        console.log('[oStatsI18n] Video ended')
        await stopWatchTimeTracking(videoPlayer)
      })

      videoPlayer.addEventListener('waiting', async () => {
        console.log('[oStatsI18n] Video waiting/buffering')
        await stopWatchTimeTracking(videoPlayer)
      })

      videoPlayer.addEventListener('stalled', async () => {
        console.log('[oStatsI18n] Video stalled')
        await stopWatchTimeTracking(videoPlayer)
      })

      // If already playing when attached, start tracking immediately.
      if (!videoPlayer.paused && !videoPlayer.ended) {
        startWatchTimeTracking(videoPlayer)
      }

      console.log('[oStatsI18n] Video player tracking setup complete')
    }

    // Monitor route changes to stop tracking when leaving scene page
    let lastPath = window.location.pathname
    const checkPathChange = setInterval(async () => {
      const currentPath = window.location.pathname
      if (currentPath !== lastPath) {
        lastPath = currentPath
        // If we've left the scene page and tracking is active, stop it
        if (!isOnScenePage() && activeVideoElements.size > 0) {
          console.log('[oStatsI18n] Left scene page, stopping tracking')
          await stopAllWatchTimeTracking()
        }
      }
    }, 500) // Check every 500ms

    // Use MutationObserver to detect when video player is added to DOM
    const observer = new MutationObserver(() => {
      const videoPlayers = document.querySelectorAll('video')
      videoPlayers.forEach((videoPlayer) => {
        attachTrackingToVideo(videoPlayer)
      })
    })

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    })

    // Also check if video is already present
    const existingVideos = document.querySelectorAll('video')
    existingVideos.forEach((videoPlayer) => {
      attachTrackingToVideo(videoPlayer)
    })
  }

  // Initialize video player tracking on page load
  setupVideoPlayerTracking()

  // Save any remaining watch time before page unload
  window.addEventListener('beforeunload', (e) => {
    if (activeVideoElements.size > 0 || trackingIntervalId) {
      console.log('[oStatsI18n] Page unloading, saving watch time...')
      const pendingSeconds = flushTrackedWatchTime()

      if (trackingIntervalId) {
        clearInterval(trackingIntervalId)
        trackingIntervalId = null
      }

      if (pendingSeconds > 0) {
        const data = watchDataCache || {}
        const today = getTodayDate()

        if (
          data[today] &&
          typeof data[today] === 'object' &&
          'totalTime' in data[today]
        ) {
          data[today] = data[today].totalTime || 0
        }

        if (!data[today]) {
          data[today] = 0
        }
        data[today] += pendingSeconds

        watchDataCache = data
        try {
          navigator.sendBeacon(
            '/graphql',
            JSON.stringify({
              query: `mutation RunPluginTask($plugin_id: ID!, $task_name: String!, $args_map: Map) {
              runPluginTask(plugin_id: $plugin_id, task_name: $task_name, args_map: $args_map)
            }`,
              variables: {
                plugin_id: PLUGIN_ID,
                task_name: 'saveWatchData',
                args_map: { watch_data: JSON.stringify(data) },
              },
            }),
          )
        } catch (err) {
          console.error('[oStatsI18n] Failed to send beacon:', err)
        }
        console.log(`[oStatsI18n] Beforeunload: saved ${pendingSeconds}s`)
      }

      activeVideoElements.clear()
      trackingLastTickTime = 0
      currentSceneInfo = null
    }
  })

  // ===== END WATCH TIME TRACKING =====

  function createStatElement(container, title, heading, tooltip) {
    const statEl = document.createElement('div')
    statEl.classList.add('stats-element')
    container.appendChild(statEl)

    const statTitle = document.createElement('p')
    statTitle.classList.add('title')
    statTitle.innerText = title
    statEl.appendChild(statTitle)

    const statHeading = document.createElement('p')
    statHeading.classList.add('heading')
    statHeading.innerText = heading
    statEl.appendChild(statHeading)

    // Add tooltip if provided
    if (tooltip) {
      statEl.title = tooltip
      statEl.style.cursor = 'help'
    }
  }

  function createImageStatElement(container, scene, title, heading) {
    const statEl = document.createElement('div')
    statEl.classList.add('stats-element')
    statEl.style.maxWidth = '250px'
    statEl.style.textAlign = 'center'
    container.appendChild(statEl)

    const link = document.createElement('a')
    link.href = `/scenes/${scene.id}`
    link.style.textDecoration = 'none'
    link.style.display = 'block'
    statEl.appendChild(link)

    const imgContainer = document.createElement('div')
    imgContainer.style.width = '100%'
    imgContainer.style.height = '140px'
    imgContainer.style.backgroundColor = '#000'
    imgContainer.style.borderRadius = '4px'
    imgContainer.style.marginBottom = '0.5rem'
    imgContainer.style.display = 'flex'
    imgContainer.style.alignItems = 'center'
    imgContainer.style.justifyContent = 'center'
    imgContainer.style.overflow = 'hidden'
    link.appendChild(imgContainer)

    const img = document.createElement('img')
    img.src = scene.paths.screenshot
    img.style.maxWidth = '100%'
    img.style.maxHeight = '100%'
    img.style.objectFit = 'contain'
    img.style.display = 'block'
    imgContainer.appendChild(img)

    const statTitle = document.createElement('p')
    statTitle.classList.add('title')
    statTitle.innerText = title
    statTitle.style.margin = '0'
    statTitle.style.fontSize = '0.9rem'
    link.appendChild(statTitle)

    const statHeading = document.createElement('p')
    statHeading.classList.add('heading')
    statHeading.innerText = heading
    statHeading.style.margin = '0'
    statHeading.style.fontSize = '0.85rem'
    link.appendChild(statHeading)
  }

  // Helper function to get consistent YYYY-MM-DD date string in local timezone
  function getLocalDateString(date) {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  function openSceneInNewTab(sceneId) {
    window.open(`/scenes/${sceneId}`, '_blank', 'noopener,noreferrer')
  }

  // OPTIMIZATION: Pre-process O history into a day map to avoid repeated iteration
  function buildOHistoryDayMap(scenes) {
    const dayMap = new Map()
    const dayTotals = {}

    scenes.forEach((scene) => {
      if (scene.o_history && scene.o_history.length > 0) {
        scene.o_history.forEach((timestamp) => {
          // Skip invalid/undated O's
          if (!timestamp) return

          const date = new Date(timestamp)
          // Validate date
          if (isNaN(date.getTime())) return

          const day = getLocalDateString(date)

          // Add to day map (for detailed queries)
          if (!dayMap.has(day)) {
            dayMap.set(day, [])
          }
          dayMap.get(day).push({ scene, timestamp })

          // Increment totals (for quick counts)
          dayTotals[day] = (dayTotals[day] || 0) + 1
        })
      }
    })

    return { dayMap, dayTotals }
  }

  // orgasms today
  async function createOrgasmsToday(row, scenes, oHistoryCache) {
    // Get today in local timezone
    const now = new Date()
    const today = getLocalDateString(now) // YYYY-MM-DD format

    // Use pre-processed cache for instant lookup
    const todayCount = oHistoryCache.dayTotals[today] || 0

    createStatElement(row, `${todayCount} 💦`, tc("今日 O 数", "O's Today"))
  }

  // record session - day with longest watch time
  async function createWatchTimeToday(row, watchTimeData) {
    let maxDuration = 0
    let maxDay = null

    // Find day with most watch time
    Object.keys(watchTimeData).forEach((day) => {
      // Simplified format: just numbers (with migration from old format)
      let duration = watchTimeData[day]
      if (typeof duration === 'object' && 'totalTime' in duration) {
        // Migrate old format
        duration = duration.totalTime || 0
      }
      duration = duration || 0

      if (duration > maxDuration) {
        maxDuration = duration
        maxDay = day
      }
    })

    let title = tc('0分', '0m')
    let heading = tc('最长记录', 'Record Session')

    if (maxDay && maxDuration > 0) {
      const formatted = formatLocalDateShort(maxDay)

      title = formatShortDuration(maxDuration) + ' ⌛'
      heading = tc(`最长记录：${formatted}`, `Record Session: ${formatted}`)
    }

    createStatElement(row, title, heading)
  }

  // Export/Import watch time data as JSON
  function createWatchTimeExportButton(row, scenesForExport = null) {
    const container = document.createElement('div')
    container.style.display = 'flex'
    container.style.gap = '1rem'
    container.style.justifyContent = 'center'
    container.style.alignItems = 'center'
    container.style.marginTop = '2rem'
    row.appendChild(container)

    // JSON Export Button
    const jsonBtn = document.createElement('button')
    jsonBtn.innerText = tc('💾 导出 JSON', '💾 Export JSON')
    jsonBtn.style.padding = '0.5rem 1rem'
    jsonBtn.style.cursor = 'pointer'
    jsonBtn.style.border = '1px solid #555'
    jsonBtn.style.backgroundColor = 'transparent'
    jsonBtn.style.color = '#fff'
    jsonBtn.style.borderRadius = '4px'
    jsonBtn.style.fontSize = '1rem'
    container.appendChild(jsonBtn)

    jsonBtn.addEventListener('click', async () => {
      jsonBtn.disabled = true
      jsonBtn.innerText = tc('⏳ 导出中...', '⏳ Exporting...')

      try {
        const watchTimeData = await loadWatchTimeData()
        const scenes = scenesForExport || (await getScenesWithOHistory())
        const oHistoryCache = buildOHistoryDayMap(scenes)

        // Clean data for export and add O counts
        const cleanedData = {}
        Object.keys(watchTimeData).forEach((day) => {
          const dayData = watchTimeData[day]
          let watchSeconds = 0

          if (typeof dayData === 'number') {
            watchSeconds = dayData
          } else if (typeof dayData === 'object' && 'totalTime' in dayData) {
            watchSeconds = dayData.totalTime || 0
          }

          // Get O count for this day
          const oCount = oHistoryCache.dayTotals[day] || 0

          // Format as "watchTime,oCount"
          cleanedData[day] = `${watchSeconds},${oCount}`
        })

        // Create JSON with metadata
        const exportData = {
          version: '2.0',
          exported: new Date().toISOString(),
          data: cleanedData,
          totalDays: Object.keys(cleanedData).length,
          totalSeconds: Object.values(cleanedData).reduce((sum, dayData) => {
            // Parse watch time from "watchTime,oCount" format
            const watchTime =
              typeof dayData === 'string'
                ? parseInt(dayData.split(',')[0])
                : typeof dayData === 'number'
                  ? dayData
                  : 0
            return sum + watchTime
          }, 0),
        }

        // Create download link
        const blob = new Blob([JSON.stringify(exportData, null, 2)], {
          type: 'application/json',
        })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `oStatsI18n-watch-time-${new Date()
          .toISOString()
          .slice(0, 10)}.json`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)

        jsonBtn.innerText = tc('✓ 已导出！', '✓ Exported!')
        setTimeout(() => {
          jsonBtn.innerText = tc('💾 导出 JSON', '💾 Export JSON')
          jsonBtn.disabled = false
        }, 2000)
      } catch (error) {
        console.error('Export failed:', error)
        jsonBtn.innerText = tc('✗ 导出失败', '✗ Export Failed')
        setTimeout(() => {
          jsonBtn.innerText = tc('💾 导出 JSON', '💾 Export JSON')
          jsonBtn.disabled = false
        }, 2000)
      }
    })

    // Import JSON Button
    const importBtn = document.createElement('button')
    importBtn.innerText = tc('📥 导入 JSON', '📥 Import JSON')
    importBtn.style.padding = '0.5rem 1rem'
    importBtn.style.cursor = 'pointer'
    importBtn.style.border = '1px solid #555'
    importBtn.style.backgroundColor = 'transparent'
    importBtn.style.color = '#fff'
    importBtn.style.borderRadius = '4px'
    importBtn.style.fontSize = '1rem'
    container.appendChild(importBtn)

    // Help icon with tooltip (on the right)
    const helpIcon = document.createElement('div')
    helpIcon.style.width = '24px'
    helpIcon.style.height = '24px'
    helpIcon.style.borderRadius = '50%'
    helpIcon.style.backgroundColor = '#555'
    helpIcon.style.color = '#ccc'
    helpIcon.style.display = 'flex'
    helpIcon.style.alignItems = 'center'
    helpIcon.style.justifyContent = 'center'
    helpIcon.style.fontSize = '0.9rem'
    helpIcon.style.fontWeight = 'bold'
    helpIcon.style.cursor = 'help'
    helpIcon.style.transition = 'background-color 0.2s, color 0.2s'
    helpIcon.innerText = '?'
    helpIcon.title = tc(
      '观看时长数据存储在您的 Stash 服务器上，并在所有设备间同步。使用导出可将数据备份为 JSON 文件，使用导入可恢复数据。',
      'Watch time data is stored on your Stash server and syncs across all devices. Use Export to backup your data to a JSON file and Import to restore it.',
    )

    helpIcon.addEventListener('mouseenter', () => {
      helpIcon.style.backgroundColor = '#666'
      helpIcon.style.color = '#fff'
    })
    helpIcon.addEventListener('mouseleave', () => {
      helpIcon.style.backgroundColor = '#555'
      helpIcon.style.color = '#ccc'
    })

    container.appendChild(helpIcon)

    importBtn.addEventListener('click', () => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.json'

      input.onchange = async (e) => {
        const file = e.target.files[0]
        if (!file) return

        importBtn.disabled = true
        importBtn.innerText = tc('⏳ 导入中...', '⏳ Importing...')

        try {
          const text = await file.text()
          const importData = JSON.parse(text)

          // Determine if this is wrapped format (with "data" property) or direct format
          let dataToImport
          if (importData.data && typeof importData.data === 'object') {
            // New export format with wrapper
            dataToImport = importData.data
            console.log(
              '[oStatsI18n] Importing data from wrapped format, total days:',
              Object.keys(dataToImport).length,
            )
          } else if (
            importData.version === undefined &&
            typeof importData === 'object'
          ) {
            // Old direct format (just the watch data object)
            dataToImport = importData
            console.log(
              '[oStatsI18n] Importing data from direct format, total days:',
              Object.keys(dataToImport).length,
            )
          } else {
            throw new Error('Invalid file format')
          }

          // Strip O counts from import data (format: "watchTime,oCount")
          const cleanedDataToImport = {}
          Object.keys(dataToImport).forEach((day) => {
            const value = dataToImport[day]
            if (typeof value === 'string' && value.includes(',')) {
              // New format: "watchTime,oCount" - extract just watch time
              cleanedDataToImport[day] = parseInt(value.split(',')[0])
            } else if (typeof value === 'number') {
              // Old format: just a number
              cleanedDataToImport[day] = value
            } else {
              cleanedDataToImport[day] = 0
            }
          })

          console.log(
            '[oStatsI18n] Importing data sample:',
            JSON.stringify(cleanedDataToImport).substring(0, 200),
          )

          // Delete all local data and replace with imported data
          await saveWatchTimeData(cleanedDataToImport)

          // Wait a bit for file write to complete
          await new Promise((resolve) => setTimeout(resolve, 500))

          // Clear cache BEFORE verification to force fresh load from file
          watchDataCache = null
          watchDataLoaded = false

          // Verify the save by loading it back
          const verifyData = await loadWatchTimeData()
          console.log(
            '[oStatsI18n] Verification after import, total days:',
            Object.keys(verifyData).length,
          )
          console.log(
            '[oStatsI18n] Verify data sample:',
            JSON.stringify(verifyData).substring(0, 200),
          )

          importBtn.innerText = tc('✓ 已导入！', '✓ Imported!')
          setTimeout(() => {
            importBtn.innerText = tc('📥 导入 JSON', '📥 Import JSON')
            importBtn.disabled = false
            // Reload page to show new data - wait longer to ensure save completes
            window.location.reload()
          }, 2000)
        } catch (error) {
          console.error('Import failed:', error)
          importBtn.innerText = tc('✗ 导入失败', '✗ Import Failed')
          setTimeout(() => {
            importBtn.innerText = tc('📥 导入 JSON', '📥 Import JSON')
            importBtn.disabled = false
          }, 2000)
        }
      }

      input.click()
    })
  }

  // day with most orgasms
  async function createBestOrgasmDay(row, scenes, oHistoryCache) {
    // Use pre-processed totals
    const dayTotals = oHistoryCache.dayTotals

    const maxCount = Math.max(0, ...Object.values(dayTotals))
    // If multiple days tie for maxCount, choose the oldest (earliest) date.
    let bestDay = null
    if (maxCount > 0) {
      const daysWithMax = Object.keys(dayTotals).filter(
        (day) => dayTotals[day] === maxCount,
      )
      if (daysWithMax.length > 0) {
        // Dates are in YYYY-MM-DD so lexical sort gives chronological order
        daysWithMax.sort()
        bestDay = daysWithMax[0]
      }
    }

    let heading = maxCount.toString()
    let title = tc('纪录日', 'Record Day')
    if (bestDay) {
      const formatted = formatLocalDateShort(bestDay)
      heading = tc(`纪录日：${formatted}`, `Record Day: ${formatted}`)
      title = `${maxCount} ☔`
    }
    createStatElement(row, title, heading)
  }

  // consecutive days streak
  async function createOrgasmStreak(row, scenes, oHistoryCache) {
    // Use pre-processed day set
    const daySet = new Set(Object.keys(oHistoryCache.dayTotals))

    const sortedDays = Array.from(daySet).sort().reverse()
    let streak = 0
    // Get today in local timezone
    const now = new Date()
    const todayStr = getLocalDateString(now)
    const hasOToday = daySet.has(todayStr)

    // Count consecutive days without an O starting from today
    let daysSinceLastO = 0
    if (!hasOToday) {
      // Count backwards from today until we find a day with an O
      // Cap at 30 days to prevent counting indefinitely if no O history exists
      const maxDaysToCheck = sortedDays.length > 0 ? 365 : 30
      for (let i = 0; i < maxDaysToCheck; i++) {
        const checkDate = new Date(now)
        checkDate.setDate(now.getDate() - i)
        const checkDateStr = getLocalDateString(checkDate)

        if (daySet.has(checkDateStr)) {
          // Found a day with an O, stop counting
          break
        }
        daysSinceLastO++
      }
    }

    // If no O today, start checking from yesterday
    const startOffset = hasOToday ? 0 : 1

    for (let i = 0; i < sortedDays.length; i++) {
      // Calculate expected date string
      const expectedDate = new Date(now)
      expectedDate.setDate(now.getDate() - (i + startOffset))
      const expectedDateStr = getLocalDateString(expectedDate)

      if (sortedDays[i] === expectedDateStr) {
        streak++
      } else {
        break
      }
    }

    // Calculate highest streak ever and track dates
    let highestStreak = 0
    let currentStreak = 0
    let highestStreakStart = null
    let highestStreakEnd = null
    let currentStreakStart = null
    const allSortedDays = Array.from(daySet).sort()

    for (let i = 0; i < allSortedDays.length; i++) {
      if (i === 0) {
        currentStreak = 1
        currentStreakStart = allSortedDays[i]
      } else {
        const prevDate = new Date(allSortedDays[i - 1])
        const currDate = new Date(allSortedDays[i])
        const dayDiff = Math.round(
          (currDate - prevDate) / (1000 * 60 * 60 * 24),
        )

        if (dayDiff === 1) {
          currentStreak++
        } else {
          if (currentStreak > highestStreak) {
            highestStreak = currentStreak
            highestStreakStart = currentStreakStart
            highestStreakEnd = allSortedDays[i - 1]
          }
          currentStreak = 1
          currentStreakStart = allSortedDays[i]
        }
      }
    }
    // Check final streak
    if (currentStreak > highestStreak) {
      highestStreak = currentStreak
      highestStreakStart = currentStreakStart
      highestStreakEnd = allSortedDays[allSortedDays.length - 1]
    }

    // Determine if we should show "No Nut Streak" mode (2 or more days without O)
    // Only activate if there's some O history (otherwise streak is just 0)
    const isNoNutMode =
      sortedDays.length > 0 && daysSinceLastO > 1 && !hasOToday

    let displayStreak
    let streakHeading
    if (isNoNutMode) {
      // No Nut Streak Counter mode
      displayStreak = `${daysSinceLastO} 🥜`
      streakHeading = tc('戒撸天数', 'No Nut Streak')
    } else if (streak > 0 && !hasOToday) {
      // Show tombstone if there's a streak but no O today (streak will be lost)
      displayStreak = streak > 1 ? `${streak} 🪦` : `${streak} 🪦`
      streakHeading = tc('连续', 'Streak')
    } else {
      // Normal streak mode
      displayStreak = streak > 1 ? `${streak} 🔥` : streak
      streakHeading = tc('连续', 'Streak')
    }

    // Format tooltip with dates
    let tooltip = null
    if (highestStreak > 0 && highestStreakStart && highestStreakEnd) {
      const formatDate = (dateStr) => {
        return formatLocalDate(dateStr)
      }
      tooltip = tc(
        `最高连续：${highestStreak} 天\n${formatDate(highestStreakStart)}\n至\n${formatDate(highestStreakEnd)}`,
        `Highest Streak: ${highestStreak} days\n${formatDate(highestStreakStart)}\nto\n${formatDate(highestStreakEnd)}`,
      )
    }
    createStatElement(row, displayStreak, streakHeading, tooltip)
  }

  // average O per minute of watch time (overall)
  async function createAverageOPerMinute(
    row,
    scenes,
    watchTimeData,
    oHistoryCache,
  ) {
    // Get total watch time in seconds and find first day with watch time
    let totalWatchTimeSeconds = 0
    let firstWatchDay = null

    const watchDays = Object.keys(watchTimeData).sort()
    if (watchDays.length > 0) {
      firstWatchDay = watchDays[0]
    }

    Object.values(watchTimeData).forEach((dayData) => {
      if (typeof dayData === 'object' && 'totalTime' in dayData) {
        totalWatchTimeSeconds += dayData.totalTime || 0
      } else {
        totalWatchTimeSeconds += dayData || 0
      }
    })

    // Count total O's only from first watch day onward using cache
    let totalOs = 0
    if (firstWatchDay) {
      Object.keys(oHistoryCache.dayTotals).forEach((day) => {
        if (day >= firstWatchDay) {
          totalOs += oHistoryCache.dayTotals[day]
        }
      })
    } else {
      // If no watch history, count all O's
      Object.values(oHistoryCache.dayTotals).forEach((count) => {
        totalOs += count
      })
    }

    // Convert to minutes
    const totalWatchTimeMinutes = totalWatchTimeSeconds / 60

    // Calculate average minutes per O
    let avgMinPerO = 0
    if (totalOs > 0) {
      avgMinPerO = totalWatchTimeMinutes / totalOs
    }

    // Format the display with time unit
    let displayText = tc('0秒', '0s')
    if (avgMinPerO > 0) {
      if (avgMinPerO >= 60) {
        // Show hours
        const hours = avgMinPerO / 60
        displayText = tc(hours.toFixed(1) + ' 小时', hours.toFixed(1) + 'h')
      } else if (avgMinPerO >= 1) {
        // Show minutes
        if (avgMinPerO >= 10) {
          displayText = tc(avgMinPerO.toFixed(1) + ' 分钟', avgMinPerO.toFixed(1) + 'm')
        } else {
          displayText = tc(avgMinPerO.toFixed(2) + ' 分钟', avgMinPerO.toFixed(2) + 'm')
        }
      } else {
        // Show seconds
        const seconds = avgMinPerO * 60
        displayText = tc(seconds.toFixed(0) + ' 秒', seconds.toFixed(0) + 's')
      }
    }

    createStatElement(
      row,
      `${displayText} ⏱️`,
      tc('平均分钟/O', 'Average min/O'),
      tc('平均每次高潮所需分钟数', 'Average minutes to orgasm ratio'),
    )
  }

  // longest watched day
  async function createLongestWatchedDay(row, scenes = null) {
    const sceneList = scenes || (await getScenesWithPlayHistory())
    const dayTotals = {}

    // Calculate total watch time per day
    sceneList.forEach((scene) => {
      if (scene.play_history && scene.play_history.length > 0) {
        scene.play_history.forEach((timestamp) => {
          // Convert UTC timestamp to local timezone
          const date = new Date(timestamp)
          const day = getLocalDateString(date) // YYYY-MM-DD format

          if (scene.play_duration && scene.play_duration > 0) {
            const durationPerPlay =
              scene.play_duration / scene.play_history.length
            dayTotals[day] = (dayTotals[day] || 0) + durationPerPlay
          }
        })
      }
    })

    let maxDuration = 0
    let maxDay = null

    Object.keys(dayTotals).forEach((day) => {
      if (dayTotals[day] > maxDuration) {
        maxDuration = dayTotals[day]
        maxDay = day
      }
    })

    let title = tc('0分', '0m')
    let heading = tc('最长记录', 'Record Session')
    if (maxDay) {
      const formatted = formatLocalDateShort(maxDay)

      title = formatShortDuration(maxDuration) + ' ⌛'
      heading = tc(`最长记录：${formatted}`, `Record Session: ${formatted}`)
    }

    createStatElement(row, title, heading)
  }

  // scene with most orgasms
  async function createMostOScene(row, scenes) {
    let maxScene = null
    let maxCount = 0

    scenes.forEach((scene) => {
      const count = scene.o_counter || 0
      if (count > maxCount) {
        maxCount = count
        maxScene = scene
      }
    })

    if (maxScene) {
      createImageStatElement(row, maxScene, maxCount, tc("O 次数最多的场景", "Scene with Most O's"))
    } else {
      createStatElement(row, tc('暂无', 'N/A'), tc("O 次数最多的场景", "Scene with Most O's"))
    }
  }

  // longest watched scene
  async function createLongestWatchedScene(row, scenes = null) {
    const sceneList = scenes || (await getScenesWithOHistory())
    let maxScene = null
    let maxDuration = 0

    sceneList.forEach((scene) => {
      const duration = scene.play_duration || 0
      if (duration > maxDuration) {
        maxDuration = duration
        maxScene = scene
      }
    })

    if (maxScene) {
      const hours = Math.floor(maxDuration / 3600)
      const minutes = Math.floor((maxDuration % 3600) / 60)
      const seconds = Math.floor(maxDuration % 60)
      let timeStr = ''
      if (hours > 0) {
        timeStr = tc(`${hours}时 ${minutes}分`, `${hours}h ${minutes}m`)
      } else if (minutes > 0) {
        timeStr = tc(`${minutes}分 ${seconds}秒`, `${minutes}m ${seconds}s`)
      } else {
        timeStr = tc(`${seconds}秒`, `${seconds}s`)
      }
      createImageStatElement(row, maxScene, timeStr, tc('最长播放时长', 'Longest Play Duration'))
    } else {
      createStatElement(row, tc('暂无', 'N/A'), tc('最长播放时长', 'Longest Play Duration'))
    }
  }

  // most recent O scene
  async function createMostRecentOScene(row, scenes) {
    let recentScene = null
    let recentTimestamp = null

    scenes.forEach((scene) => {
      if (scene.o_history && scene.o_history.length > 0) {
        // Filter out invalid timestamps
        const validTimestamps = scene.o_history.filter((t) => {
          if (!t) return false
          const date = new Date(t)
          return !isNaN(date.getTime())
        })

        if (validTimestamps.length === 0) return

        const mostRecent = validTimestamps.sort().reverse()[0]
        if (!recentTimestamp || mostRecent > recentTimestamp) {
          recentTimestamp = mostRecent
          recentScene = scene
        }
      }
    })

    if (recentScene) {
      const date = new Date(recentTimestamp)
      const timeAgo = formatTimeAgo(date)
      createImageStatElement(row, recentScene, timeAgo, tc('最近 O', 'Most Recent O'))
    }
  }

  // oldest O scene
  async function createOldestOScene(row, scenes) {
    let oldestScene = null
    let oldestRecentTimestamp = null

    scenes.forEach((scene) => {
      if (scene.o_history && scene.o_history.length > 0) {
        // Filter out invalid timestamps
        const validTimestamps = scene.o_history.filter((t) => {
          if (!t) return false
          const date = new Date(t)
          return !isNaN(date.getTime())
        })

        if (validTimestamps.length === 0) return

        // Get the most recent O for this scene
        const mostRecent = validTimestamps.sort().reverse()[0]
        if (!oldestRecentTimestamp || mostRecent < oldestRecentTimestamp) {
          oldestRecentTimestamp = mostRecent
          oldestScene = scene
        }
      }
    })

    if (oldestScene) {
      const date = new Date(oldestRecentTimestamp)
      const timeAgo = formatTimeAgo(date)
      createImageStatElement(row, oldestScene, timeAgo, tc('最早 O', 'Oldest O'))
    }
  }

  // helper to format time ago
  function formatTimeAgo(date) {
    const now = new Date()
    const diffMs = now - date
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)
    const diffMonths = Math.floor(diffDays / 30)
    const diffYears = Math.floor(diffDays / 365)

    if (diffMins < 60) {
      return tc(`${diffMins} 分钟前`, `${diffMins}m ago`)
    } else if (diffHours < 24) {
      return tc(`${diffHours} 小时前`, `${diffHours}h ago`)
    } else if (diffDays < 30) {
      return tc(`${diffDays} 天前`, `${diffDays}d ago`)
    } else if (diffMonths < 12) {
      return tc(`${diffMonths} 个月前`, `${diffMonths}mo ago`)
    } else {
      return tc(`${diffYears} 年前`, `${diffYears}y ago`)
    }
  }

  // weekly bar chart
  async function createWeeklyBarChart(row, scenes, oHistoryCache) {
    // Create chart container
    const chartContainer = document.createElement('div')
    chartContainer.style.width = '100%'
    chartContainer.style.maxWidth = '800px'
    chartContainer.style.margin = '0 auto'
    chartContainer.style.padding = '1rem'
    row.appendChild(chartContainer)

    // Create header with title and buttons
    const headerContainer = document.createElement('div')
    headerContainer.style.display = 'flex'
    headerContainer.style.justifyContent = 'space-between'
    headerContainer.style.alignItems = 'center'
    headerContainer.style.marginBottom = '1rem'
    chartContainer.appendChild(headerContainer)

    const chartTitle = document.createElement('h4')
    chartTitle.innerText = tc("O 统计", "O'S")
    chartTitle.style.textAlign = 'center'
    chartTitle.style.fontSize = '1.2rem'
    chartTitle.style.margin = '0'
    headerContainer.appendChild(chartTitle)

    // Create button container
    const buttonContainer = document.createElement('div')
    buttonContainer.style.display = 'flex'
    buttonContainer.style.gap = '0.5rem'
    headerContainer.appendChild(buttonContainer)

    // Create view buttons
    const weekBtn = document.createElement('button')
    weekBtn.innerText = tc('本周', 'This Week')
    weekBtn.style.padding = '0.25rem 0.75rem'
    weekBtn.style.cursor = 'pointer'
    weekBtn.style.border = '1px solid #007bff'
    weekBtn.style.backgroundColor = '#007bff'
    weekBtn.style.color = '#fff'
    weekBtn.style.borderRadius = '4px'
    buttonContainer.appendChild(weekBtn)

    const monthBtn = document.createElement('button')
    monthBtn.innerText = tc('本月', 'This Month')
    monthBtn.style.padding = '0.25rem 0.75rem'
    monthBtn.style.cursor = 'pointer'
    monthBtn.style.border = '1px solid #555'
    monthBtn.style.backgroundColor = 'transparent'
    monthBtn.style.color = '#fff'
    monthBtn.style.borderRadius = '4px'
    buttonContainer.appendChild(monthBtn)

    const yearBtn = document.createElement('button')
    yearBtn.innerText = tc('今年', 'This Year')
    yearBtn.style.padding = '0.25rem 0.75rem'
    yearBtn.style.cursor = 'pointer'
    yearBtn.style.border = '1px solid #555'
    yearBtn.style.backgroundColor = 'transparent'
    yearBtn.style.color = '#fff'
    yearBtn.style.borderRadius = '4px'
    buttonContainer.appendChild(yearBtn)

    // Create bars container
    const barsContainer = document.createElement('div')
    barsContainer.style.display = 'flex'
    barsContainer.style.alignItems = 'flex-end'
    barsContainer.style.justifyContent = 'space-around'
    barsContainer.style.height = '300px'
    barsContainer.style.gap = '4px'
    chartContainer.appendChild(barsContainer)

    // Create week navigation (initially visible)
    const weekNavContainer = document.createElement('div')
    weekNavContainer.style.display = 'flex'
    weekNavContainer.style.justifyContent = 'center'
    weekNavContainer.style.alignItems = 'center'
    weekNavContainer.style.gap = '1rem'
    weekNavContainer.style.marginTop = '0.5rem'
    chartContainer.appendChild(weekNavContainer)

    const prevWeekBtn = document.createElement('button')
    prevWeekBtn.innerText = tc('← 上一个', '← Prev')
    prevWeekBtn.style.padding = '0.25rem 0.75rem'
    prevWeekBtn.style.cursor = 'pointer'
    prevWeekBtn.style.border = '1px solid #555'
    prevWeekBtn.style.backgroundColor = 'transparent'
    prevWeekBtn.style.color = '#fff'
    prevWeekBtn.style.borderRadius = '4px'
    weekNavContainer.appendChild(prevWeekBtn)

    const weekLabel = document.createElement('span')
    weekLabel.style.fontSize = '1rem'
    weekLabel.style.fontWeight = 'bold'
    weekNavContainer.appendChild(weekLabel)

    const nextWeekBtn = document.createElement('button')
    nextWeekBtn.innerText = tc('下一个 →', 'Next →')
    nextWeekBtn.style.padding = '0.25rem 0.75rem'
    nextWeekBtn.style.cursor = 'pointer'
    nextWeekBtn.style.border = '1px solid #555'
    nextWeekBtn.style.backgroundColor = 'transparent'
    nextWeekBtn.style.color = '#fff'
    nextWeekBtn.style.borderRadius = '4px'
    weekNavContainer.appendChild(nextWeekBtn)

    // Create month navigation (initially hidden)
    const monthNavContainer = document.createElement('div')
    monthNavContainer.style.display = 'none'
    monthNavContainer.style.justifyContent = 'center'
    monthNavContainer.style.alignItems = 'center'
    monthNavContainer.style.gap = '1rem'
    monthNavContainer.style.marginTop = '0.5rem'
    chartContainer.appendChild(monthNavContainer)

    const prevMonthBtn = document.createElement('button')
    prevMonthBtn.innerText = tc('← 上一个', '← Prev')
    prevMonthBtn.style.padding = '0.25rem 0.75rem'
    prevMonthBtn.style.cursor = 'pointer'
    prevMonthBtn.style.border = '1px solid #555'
    prevMonthBtn.style.backgroundColor = 'transparent'
    prevMonthBtn.style.color = '#fff'
    prevMonthBtn.style.borderRadius = '4px'
    monthNavContainer.appendChild(prevMonthBtn)

    const monthLabel = document.createElement('span')
    monthLabel.style.fontSize = '1rem'
    monthLabel.style.fontWeight = 'bold'
    monthNavContainer.appendChild(monthLabel)

    const nextMonthBtn = document.createElement('button')
    nextMonthBtn.innerText = tc('下一个 →', 'Next →')
    nextMonthBtn.style.padding = '0.25rem 0.75rem'
    nextMonthBtn.style.cursor = 'pointer'
    nextMonthBtn.style.border = '1px solid #555'
    nextMonthBtn.style.backgroundColor = 'transparent'
    nextMonthBtn.style.color = '#fff'
    nextMonthBtn.style.borderRadius = '4px'
    monthNavContainer.appendChild(nextMonthBtn)

    // Create year navigation (initially hidden)
    const yearNavContainer = document.createElement('div')
    yearNavContainer.style.display = 'none'
    yearNavContainer.style.justifyContent = 'center'
    yearNavContainer.style.alignItems = 'center'
    yearNavContainer.style.gap = '1rem'
    yearNavContainer.style.marginTop = '0.5rem'
    chartContainer.appendChild(yearNavContainer)

    const prevYearBtn = document.createElement('button')
    prevYearBtn.innerText = tc('← 上一个', '\u2190 Prev')
    prevYearBtn.style.padding = '0.25rem 0.75rem'
    prevYearBtn.style.cursor = 'pointer'
    prevYearBtn.style.border = '1px solid #555'
    prevYearBtn.style.backgroundColor = 'transparent'
    prevYearBtn.style.color = '#fff'
    prevYearBtn.style.borderRadius = '4px'
    yearNavContainer.appendChild(prevYearBtn)

    const yearLabel = document.createElement('span')
    yearLabel.style.fontSize = '1rem'
    yearLabel.style.fontWeight = 'bold'
    yearNavContainer.appendChild(yearLabel)

    const nextYearBtn = document.createElement('button')
    nextYearBtn.innerText = tc('下一个 →', 'Next \u2192')
    nextYearBtn.style.padding = '0.25rem 0.75rem'
    nextYearBtn.style.cursor = 'pointer'
    nextYearBtn.style.border = '1px solid #555'
    nextYearBtn.style.backgroundColor = 'transparent'
    nextYearBtn.style.color = '#fff'
    nextYearBtn.style.borderRadius = '4px'
    yearNavContainer.appendChild(nextYearBtn)

    // Track selected week (0 = current week, -1 = prev week, etc.)
    let selectedWeekOffset = 0
    // Track selected month (0 = current month, -1 = prev month, etc.)
    let selectedMonthOffset = 0
    // Track selected year (0 = current year, -1 = prev year, etc.)
    let selectedYearOffset = 0

    // Function to render chart
    function renderChart(view) {
      // Update button styles
      weekBtn.style.backgroundColor =
        view === 'week' ? '#007bff' : 'transparent'
      weekBtn.style.border =
        view === 'week' ? '1px solid #007bff' : '1px solid #555'
      monthBtn.style.backgroundColor =
        view === 'month' ? '#007bff' : 'transparent'
      monthBtn.style.border =
        view === 'month' ? '1px solid #007bff' : '1px solid #555'
      yearBtn.style.backgroundColor =
        view === 'year' ? '#007bff' : 'transparent'
      yearBtn.style.border =
        view === 'year' ? '1px solid #007bff' : '1px solid #555'

      // Show/hide week, month and year navigation
      weekNavContainer.style.display = view === 'week' ? 'flex' : 'none'
      monthNavContainer.style.display = view === 'month' ? 'flex' : 'none'
      yearNavContainer.style.display = view === 'year' ? 'flex' : 'none'

      // Use pre-processed day totals
      const dayTotals = oHistoryCache.dayTotals

      const now = new Date()
      let data = []

      if (view === 'week') {
        // Get Monday of selected week (current week + offset)
        const dayOfWeek = now.getDay()
        const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek // Adjust to Monday
        const monday = new Date(now)
        monday.setDate(now.getDate() + diff + selectedWeekOffset * 7)
        monday.setHours(0, 0, 0, 0)

        // Update week label
        const sunday = new Date(monday)
        sunday.setDate(monday.getDate() + 6)
        const mondayStr = monday.toLocaleDateString(fmtDateLocale(), {
          month: 'short',
          day: 'numeric',
        })
        const sundayStr = sunday.toLocaleDateString(fmtDateLocale(), {
          month: 'short',
          day: 'numeric',
        })
        weekLabel.innerText = `${mondayStr} - ${sundayStr}`

        // Disable next button if viewing current week
        nextWeekBtn.disabled = selectedWeekOffset >= 0
        nextWeekBtn.style.opacity = selectedWeekOffset >= 0 ? '0.5' : '1'
        nextWeekBtn.style.cursor =
          selectedWeekOffset >= 0 ? 'not-allowed' : 'pointer'

        for (let i = 0; i < 7; i++) {
          const date = new Date(monday)
          date.setDate(monday.getDate() + i)
          const dayStr = getLocalDateString(date)
          const weekday = date.toLocaleDateString(fmtDateLocale(), { weekday: 'short' })
          const dayNum = date.getDate()
          data.push({
            date: dayStr,
            count: dayTotals[dayStr] || 0,
            label: `${weekday} ${dayNum}`,
          })
        }
      } else if (view === 'month') {
        // Current month (with offset) - from day 1 to last day
        const targetDate = new Date(
          now.getFullYear(),
          now.getMonth() + selectedMonthOffset,
          1,
        )
        const firstDay = new Date(
          targetDate.getFullYear(),
          targetDate.getMonth(),
          1,
        )
        const lastDay = new Date(
          targetDate.getFullYear(),
          targetDate.getMonth() + 1,
          0,
        )
        const daysInMonth = lastDay.getDate()

        // Update month label and button states
        monthLabel.innerText = targetDate.toLocaleDateString(fmtDateLocale(), {
          month: 'long',
          year: 'numeric',
        })
        nextMonthBtn.disabled = selectedMonthOffset >= 0
        nextMonthBtn.style.opacity = selectedMonthOffset >= 0 ? '0.5' : '1'
        nextMonthBtn.style.cursor =
          selectedMonthOffset >= 0 ? 'not-allowed' : 'pointer'

        for (let i = 1; i <= daysInMonth; i++) {
          const date = new Date(
            targetDate.getFullYear(),
            targetDate.getMonth(),
            i,
          )
          const dayStr = getLocalDateString(date)
          data.push({
            date: dayStr,
            count: dayTotals[dayStr] || 0,
            label: i.toString(),
          })
        }
      } else if (view === 'year') {
        // Get month totals for selected year
        const targetYear = now.getFullYear() + selectedYearOffset
        const monthTotals = {}
        Object.keys(dayTotals).forEach((dayStr) => {
          const date = new Date(dayStr)
          if (date.getFullYear() === targetYear) {
            const month = date.getMonth()
            monthTotals[month] = (monthTotals[month] || 0) + dayTotals[dayStr]
          }
        })

        // Update year label and button states
        yearLabel.innerText = targetYear.toString()
        nextYearBtn.disabled = selectedYearOffset >= 0
        nextYearBtn.style.opacity = selectedYearOffset >= 0 ? '0.5' : '1'
        nextYearBtn.style.cursor =
          selectedYearOffset >= 0 ? 'not-allowed' : 'pointer'

        const monthNames = [
          tc('1月', 'Jan'),
          tc('2月', 'Feb'),
          tc('3月', 'Mar'),
          tc('4月', 'Apr'),
          tc('5月', 'May'),
          tc('6月', 'Jun'),
          tc('7月', 'Jul'),
          tc('8月', 'Aug'),
          tc('9月', 'Sep'),
          tc('10月', 'Oct'),
          tc('11月', 'Nov'),
          tc('12月', 'Dec'),
        ]
        for (let i = 0; i < 12; i++) {
          data.push({
            date: `${targetYear}-${i}`,
            count: monthTotals[i] || 0,
            label: monthNames[i],
          })
        }
      }

      const nonZeroCounts = data.filter((d) => d.count > 0).map((d) => d.count)
      const maxCount = nonZeroCounts.length > 0 ? Math.max(...nonZeroCounts) : 1

      // Clear and render bars
      barsContainer.innerHTML = ''
      data.forEach((item) => {
        const barWrapper = document.createElement('div')
        barWrapper.style.flex = '1'
        barWrapper.style.display = 'flex'
        barWrapper.style.flexDirection = 'column'
        barWrapper.style.alignItems = 'center'
        barWrapper.style.height = '100%'
        barWrapper.style.justifyContent = 'flex-end'
        barsContainer.appendChild(barWrapper)

        const barContainer = document.createElement('div')
        barContainer.style.width = '100%'
        barContainer.style.display = 'flex'
        barContainer.style.flexDirection = 'column'
        barContainer.style.alignItems = 'center'
        barContainer.style.justifyContent = 'flex-end'
        barContainer.style.flex = '1'
        barWrapper.appendChild(barContainer)

        const bar = document.createElement('div')
        const height = item.count > 0 ? (item.count / maxCount) * 100 : 0
        bar.style.width = '100%'
        bar.style.height = `${height}%`
        bar.style.backgroundColor = '#007bff'
        bar.style.borderRadius = '4px 4px 0 0'
        bar.style.minHeight = item.count > 0 ? '4px' : '0'
        bar.style.position = 'relative'
        bar.style.cursor = item.count > 0 ? 'pointer' : 'default'
        bar.style.transition = 'opacity 0.2s'
        barContainer.appendChild(bar)

        if (item.count > 0 && view !== 'year') {
          bar.addEventListener('mouseenter', () => {
            bar.style.opacity = '0.7'
          })
          bar.addEventListener('mouseleave', () => {
            bar.style.opacity = '1'
          })
          bar.addEventListener('click', () => {
            // Parse date string properly to avoid timezone issues
            const dateParts = item.date.split('-')
            const targetDate = new Date(
              parseInt(dateParts[0]),
              parseInt(dateParts[1]) - 1,
              parseInt(dateParts[2]),
            )
            const now = new Date()
            const nowLocal = new Date(
              now.getFullYear(),
              now.getMonth(),
              now.getDate(),
            )
            const dayDiff = Math.round(
              (targetDate - nowLocal) / (1000 * 60 * 60 * 24),
            )

            if (window.onThisDayRender) {
              window.onThisDayRender(dayDiff)
            }

            const section = document.getElementById('on-this-day-section')
            if (section) {
              section.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
          })
        }

        // Update cursor for year view or if no data
        if (view === 'year' || item.count === 0) {
          bar.style.cursor = 'default'
        }

        const countLabel = document.createElement('div')
        countLabel.innerText = item.count
        countLabel.style.fontSize = '0.9rem'
        countLabel.style.fontWeight = 'bold'
        countLabel.style.marginBottom = '4px'
        countLabel.style.color = '#fff'
        countLabel.style.visibility = item.count === 0 ? 'hidden' : 'visible'
        barContainer.insertBefore(countLabel, bar)

        const dayLabel = document.createElement('div')
        dayLabel.innerText = item.label
        dayLabel.style.fontSize = '0.85rem'
        dayLabel.style.marginTop = '8px'
        dayLabel.style.textAlign = 'center'
        barWrapper.appendChild(dayLabel)
      })
    }

    // Add button click handlers
    weekBtn.addEventListener('click', async () => {
      selectedWeekOffset = 0
      selectedMonthOffset = 0
      selectedYearOffset = 0
      await renderChart('week')
    })
    monthBtn.addEventListener('click', async () => {
      selectedWeekOffset = 0
      selectedMonthOffset = 0
      selectedYearOffset = 0
      await renderChart('month')
    })
    yearBtn.addEventListener('click', async () => {
      selectedWeekOffset = 0
      selectedMonthOffset = 0
      selectedYearOffset = 0
      await renderChart('year')
    })

    prevWeekBtn.addEventListener('click', async () => {
      selectedWeekOffset--
      await renderChart('week')
    })

    nextWeekBtn.addEventListener('click', async () => {
      if (selectedWeekOffset < 0) {
        selectedWeekOffset++
        await renderChart('week')
      }
    })

    prevMonthBtn.addEventListener('click', async () => {
      selectedMonthOffset--
      await renderChart('month')
    })

    nextMonthBtn.addEventListener('click', async () => {
      if (selectedMonthOffset < 0) {
        selectedMonthOffset++
        await renderChart('month')
      }
    })

    prevYearBtn.addEventListener('click', async () => {
      selectedYearOffset--
      await renderChart('year')
    })

    nextYearBtn.addEventListener('click', async () => {
      if (selectedYearOffset < 0) {
        selectedYearOffset++
        await renderChart('year')
      }
    })

    // Initial render
    await renderChart('week')
  }

  // Watch Time Bar Chart
  async function createWatchTimeBarChart(row, watchTimeData) {
    // Create chart container
    const chartContainer = document.createElement('div')
    chartContainer.style.width = '100%'
    chartContainer.style.maxWidth = '800px'
    chartContainer.style.margin = '0 auto'
    chartContainer.style.padding = '1rem'
    row.appendChild(chartContainer)

    // Create header with title and buttons
    const headerContainer = document.createElement('div')
    headerContainer.style.display = 'flex'
    headerContainer.style.justifyContent = 'space-between'
    headerContainer.style.alignItems = 'center'
    headerContainer.style.marginBottom = '1rem'
    chartContainer.appendChild(headerContainer)

    const chartTitle = document.createElement('h4')
    chartTitle.innerText = tc('观看时长', 'WATCH TIME')
    chartTitle.style.textAlign = 'center'
    chartTitle.style.fontSize = '1.2rem'
    chartTitle.style.margin = '0'
    headerContainer.appendChild(chartTitle)

    // Create button container
    const buttonContainer = document.createElement('div')
    buttonContainer.style.display = 'flex'
    buttonContainer.style.gap = '0.5rem'
    headerContainer.appendChild(buttonContainer)

    // Create view buttons
    const weekBtn = document.createElement('button')
    weekBtn.innerText = tc('本周', 'This Week')
    weekBtn.style.padding = '0.25rem 0.75rem'
    weekBtn.style.cursor = 'pointer'
    weekBtn.style.border = '1px solid #28a745'
    weekBtn.style.backgroundColor = '#28a745'
    weekBtn.style.color = '#fff'
    weekBtn.style.borderRadius = '4px'
    buttonContainer.appendChild(weekBtn)

    const monthBtn = document.createElement('button')
    monthBtn.innerText = tc('本月', 'This Month')
    monthBtn.style.padding = '0.25rem 0.75rem'
    monthBtn.style.cursor = 'pointer'
    monthBtn.style.border = '1px solid #555'
    monthBtn.style.backgroundColor = 'transparent'
    monthBtn.style.color = '#fff'
    monthBtn.style.borderRadius = '4px'
    buttonContainer.appendChild(monthBtn)

    const yearBtn = document.createElement('button')
    yearBtn.innerText = tc('今年', 'This Year')
    yearBtn.style.padding = '0.25rem 0.75rem'
    yearBtn.style.cursor = 'pointer'
    yearBtn.style.border = '1px solid #555'
    yearBtn.style.backgroundColor = 'transparent'
    yearBtn.style.color = '#fff'
    yearBtn.style.borderRadius = '4px'
    buttonContainer.appendChild(yearBtn)

    // Create bars container
    const barsContainer = document.createElement('div')
    barsContainer.style.display = 'flex'
    barsContainer.style.alignItems = 'flex-end'
    barsContainer.style.justifyContent = 'space-around'
    barsContainer.style.height = '300px'
    barsContainer.style.gap = '4px'
    chartContainer.appendChild(barsContainer)

    // Create week navigation (initially visible)
    const weekNavContainer = document.createElement('div')
    weekNavContainer.style.display = 'flex'
    weekNavContainer.style.justifyContent = 'center'
    weekNavContainer.style.alignItems = 'center'
    weekNavContainer.style.gap = '1rem'
    weekNavContainer.style.marginTop = '0.5rem'
    chartContainer.appendChild(weekNavContainer)

    const prevWeekBtn = document.createElement('button')
    prevWeekBtn.innerText = tc('← 上一个', '\u2190 Prev')
    prevWeekBtn.style.padding = '0.25rem 0.75rem'
    prevWeekBtn.style.cursor = 'pointer'
    prevWeekBtn.style.border = '1px solid #555'
    prevWeekBtn.style.backgroundColor = 'transparent'
    prevWeekBtn.style.color = '#fff'
    prevWeekBtn.style.borderRadius = '4px'
    weekNavContainer.appendChild(prevWeekBtn)

    const weekLabel = document.createElement('span')
    weekLabel.style.fontSize = '1rem'
    weekLabel.style.fontWeight = 'bold'
    weekNavContainer.appendChild(weekLabel)

    const nextWeekBtn = document.createElement('button')
    nextWeekBtn.innerText = tc('下一个 →', 'Next \u2192')
    nextWeekBtn.style.padding = '0.25rem 0.75rem'
    nextWeekBtn.style.cursor = 'pointer'
    nextWeekBtn.style.border = '1px solid #555'
    nextWeekBtn.style.backgroundColor = 'transparent'
    nextWeekBtn.style.color = '#fff'
    nextWeekBtn.style.borderRadius = '4px'
    weekNavContainer.appendChild(nextWeekBtn)

    // Create month navigation (initially hidden)
    const monthNavContainer = document.createElement('div')
    monthNavContainer.style.display = 'none'
    monthNavContainer.style.justifyContent = 'center'
    monthNavContainer.style.alignItems = 'center'
    monthNavContainer.style.gap = '1rem'
    monthNavContainer.style.marginTop = '0.5rem'
    chartContainer.appendChild(monthNavContainer)

    const prevMonthBtn = document.createElement('button')
    prevMonthBtn.innerText = tc('← 上一个', '\u2190 Prev')
    prevMonthBtn.style.padding = '0.25rem 0.75rem'
    prevMonthBtn.style.cursor = 'pointer'
    prevMonthBtn.style.border = '1px solid #555'
    prevMonthBtn.style.backgroundColor = 'transparent'
    prevMonthBtn.style.color = '#fff'
    prevMonthBtn.style.borderRadius = '4px'
    monthNavContainer.appendChild(prevMonthBtn)

    const monthLabel = document.createElement('span')
    monthLabel.style.fontSize = '1rem'
    monthLabel.style.fontWeight = 'bold'
    monthNavContainer.appendChild(monthLabel)

    const nextMonthBtn = document.createElement('button')
    nextMonthBtn.innerText = tc('下一个 →', 'Next \u2192')
    nextMonthBtn.style.padding = '0.25rem 0.75rem'
    nextMonthBtn.style.cursor = 'pointer'
    nextMonthBtn.style.border = '1px solid #555'
    nextMonthBtn.style.backgroundColor = 'transparent'
    nextMonthBtn.style.color = '#fff'
    nextMonthBtn.style.borderRadius = '4px'
    monthNavContainer.appendChild(nextMonthBtn)

    // Create year navigation (initially hidden)
    const yearNavContainer = document.createElement('div')
    yearNavContainer.style.display = 'none'
    yearNavContainer.style.justifyContent = 'center'
    yearNavContainer.style.alignItems = 'center'
    yearNavContainer.style.gap = '1rem'
    yearNavContainer.style.marginTop = '0.5rem'
    chartContainer.appendChild(yearNavContainer)

    const prevYearBtn = document.createElement('button')
    prevYearBtn.innerText = tc('← 上一个', '\u2190 Prev')
    prevYearBtn.style.padding = '0.25rem 0.75rem'
    prevYearBtn.style.cursor = 'pointer'
    prevYearBtn.style.border = '1px solid #555'
    prevYearBtn.style.backgroundColor = 'transparent'
    prevYearBtn.style.color = '#fff'
    prevYearBtn.style.borderRadius = '4px'
    yearNavContainer.appendChild(prevYearBtn)

    const yearLabel = document.createElement('span')
    yearLabel.style.fontSize = '1rem'
    yearLabel.style.fontWeight = 'bold'
    yearNavContainer.appendChild(yearLabel)

    const nextYearBtn = document.createElement('button')
    nextYearBtn.innerText = tc('下一个 →', 'Next \u2192')
    nextYearBtn.style.padding = '0.25rem 0.75rem'
    nextYearBtn.style.cursor = 'pointer'
    nextYearBtn.style.border = '1px solid #555'
    nextYearBtn.style.backgroundColor = 'transparent'
    nextYearBtn.style.color = '#fff'
    nextYearBtn.style.borderRadius = '4px'
    yearNavContainer.appendChild(nextYearBtn)

    // Track selected week/month/year offsets
    let selectedWeekOffset = 0
    let selectedMonthOffset = 0
    let selectedYearOffset = 0

    // Duration formatting is localized via formatShortDuration

    // Function to render chart
    async function renderChart(view) {
      // Update button styles
      weekBtn.style.backgroundColor =
        view === 'week' ? '#28a745' : 'transparent'
      weekBtn.style.border =
        view === 'week' ? '1px solid #28a745' : '1px solid #555'
      monthBtn.style.backgroundColor =
        view === 'month' ? '#28a745' : 'transparent'
      monthBtn.style.border =
        view === 'month' ? '1px solid #28a745' : '1px solid #555'
      yearBtn.style.backgroundColor =
        view === 'year' ? '#28a745' : 'transparent'
      yearBtn.style.border =
        view === 'year' ? '1px solid #28a745' : '1px solid #555'

      // Show/hide week, month and year navigation
      weekNavContainer.style.display = view === 'week' ? 'flex' : 'none'
      monthNavContainer.style.display = view === 'month' ? 'flex' : 'none'
      yearNavContainer.style.display = view === 'year' ? 'flex' : 'none'

      // Get watch time data from our tracking system
      // Convert to day totals, handling migration from old format
      const dayTotals = {}
      Object.keys(watchTimeData).forEach((day) => {
        const dayData = watchTimeData[day]
        if (typeof dayData === 'object' && 'totalTime' in dayData) {
          // Migrate old format
          dayTotals[day] = dayData.totalTime || 0
        } else {
          dayTotals[day] = dayData || 0
        }
      })

      const now = new Date()
      let data = []

      if (view === 'week') {
        // Get Monday of selected week
        const dayOfWeek = now.getDay()
        const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
        const monday = new Date(now)
        monday.setDate(now.getDate() + diff + selectedWeekOffset * 7)
        monday.setHours(0, 0, 0, 0)

        // Update week label
        const sunday = new Date(monday)
        sunday.setDate(monday.getDate() + 6)
        const mondayStr = monday.toLocaleDateString(fmtDateLocale(), {
          month: 'short',
          day: 'numeric',
        })
        const sundayStr = sunday.toLocaleDateString(fmtDateLocale(), {
          month: 'short',
          day: 'numeric',
        })
        weekLabel.innerText = `${mondayStr} - ${sundayStr}`

        // Disable next button if viewing current week
        nextWeekBtn.disabled = selectedWeekOffset >= 0
        nextWeekBtn.style.opacity = selectedWeekOffset >= 0 ? '0.5' : '1'
        nextWeekBtn.style.cursor =
          selectedWeekOffset >= 0 ? 'not-allowed' : 'pointer'

        for (let i = 0; i < 7; i++) {
          const date = new Date(monday)
          date.setDate(monday.getDate() + i)
          const dayStr = getLocalDateString(date)
          const weekday = date.toLocaleDateString(fmtDateLocale(), { weekday: 'short' })
          const dayNum = date.getDate()
          data.push({
            date: dayStr,
            duration: dayTotals[dayStr] || 0,
            label: `${weekday} ${dayNum}`,
          })
        }
      } else if (view === 'month') {
        // Current month with offset
        const targetDate = new Date(
          now.getFullYear(),
          now.getMonth() + selectedMonthOffset,
          1,
        )
        const daysInMonth = new Date(
          targetDate.getFullYear(),
          targetDate.getMonth() + 1,
          0,
        ).getDate()

        // Update month label
        monthLabel.innerText = targetDate.toLocaleDateString(fmtDateLocale(), {
          month: 'long',
          year: 'numeric',
        })
        nextMonthBtn.disabled = selectedMonthOffset >= 0
        nextMonthBtn.style.opacity = selectedMonthOffset >= 0 ? '0.5' : '1'
        nextMonthBtn.style.cursor =
          selectedMonthOffset >= 0 ? 'not-allowed' : 'pointer'

        for (let i = 1; i <= daysInMonth; i++) {
          const date = new Date(
            targetDate.getFullYear(),
            targetDate.getMonth(),
            i,
          )
          const dayStr = getLocalDateString(date)
          data.push({
            date: dayStr,
            duration: dayTotals[dayStr] || 0,
            label: i.toString(),
          })
        }
      } else if (view === 'year') {
        // Get month totals for selected year
        const targetYear = now.getFullYear() + selectedYearOffset
        const monthTotals = {}
        Object.keys(dayTotals).forEach((dayStr) => {
          const date = new Date(dayStr)
          if (date.getFullYear() === targetYear) {
            const month = date.getMonth()
            monthTotals[month] = (monthTotals[month] || 0) + dayTotals[dayStr]
          }
        })

        // Update year label
        yearLabel.innerText = targetYear.toString()
        nextYearBtn.disabled = selectedYearOffset >= 0
        nextYearBtn.style.opacity = selectedYearOffset >= 0 ? '0.5' : '1'
        nextYearBtn.style.cursor =
          selectedYearOffset >= 0 ? 'not-allowed' : 'pointer'

        const monthNames = [
          tc('1月', 'Jan'),
          tc('2月', 'Feb'),
          tc('3月', 'Mar'),
          tc('4月', 'Apr'),
          tc('5月', 'May'),
          tc('6月', 'Jun'),
          tc('7月', 'Jul'),
          tc('8月', 'Aug'),
          tc('9月', 'Sep'),
          tc('10月', 'Oct'),
          tc('11月', 'Nov'),
          tc('12月', 'Dec'),
        ]
        for (let i = 0; i < 12; i++) {
          data.push({
            date: `${targetYear}-${i}`,
            duration: monthTotals[i] || 0,
            label: monthNames[i],
          })
        }
      }

      const nonZeroDurations = data
        .filter((d) => d.duration > 0)
        .map((d) => d.duration)
      const maxDuration =
        nonZeroDurations.length > 0 ? Math.max(...nonZeroDurations) : 1

      // Clear and render bars
      barsContainer.innerHTML = ''
      data.forEach((item) => {
        const barWrapper = document.createElement('div')
        barWrapper.style.flex = '1'
        barWrapper.style.display = 'flex'
        barWrapper.style.flexDirection = 'column'
        barWrapper.style.alignItems = 'center'
        barWrapper.style.height = '100%'
        barWrapper.style.justifyContent = 'flex-end'
        barsContainer.appendChild(barWrapper)

        const barContainer = document.createElement('div')
        barContainer.style.width = '100%'
        barContainer.style.display = 'flex'
        barContainer.style.flexDirection = 'column'
        barContainer.style.alignItems = 'center'
        barContainer.style.justifyContent = 'flex-end'
        barContainer.style.flex = '1'
        barWrapper.appendChild(barContainer)

        const bar = document.createElement('div')
        const height =
          item.duration > 0 ? (item.duration / maxDuration) * 100 : 0
        bar.style.width = '100%'
        bar.style.height = `${height}%`
        bar.style.backgroundColor = '#28a745'
        bar.style.borderRadius = '4px 4px 0 0'
        bar.style.minHeight = item.duration > 0 ? '4px' : '0'
        bar.style.position = 'relative'
        bar.style.cursor = item.duration > 0 ? 'pointer' : 'default'
        bar.style.transition = 'opacity 0.2s'
        barContainer.appendChild(bar)

        if (item.duration > 0 && view !== 'year') {
          bar.addEventListener('mouseenter', () => {
            bar.style.opacity = '0.7'
          })
          bar.addEventListener('mouseleave', () => {
            bar.style.opacity = '1'
          })
          bar.addEventListener('click', () => {
            // Parse date string properly to avoid timezone issues
            const dateParts = item.date.split('-')
            const targetDate = new Date(
              parseInt(dateParts[0]),
              parseInt(dateParts[1]) - 1,
              parseInt(dateParts[2]),
            )
            const now = new Date()
            const nowLocal = new Date(
              now.getFullYear(),
              now.getMonth(),
              now.getDate(),
            )
            const dayDiff = Math.round(
              (targetDate - nowLocal) / (1000 * 60 * 60 * 24),
            )

            if (window.onThisDayRender) {
              window.onThisDayRender(dayDiff)
            }

            const section = document.getElementById('on-this-day-section')
            if (section) {
              section.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
          })
        }

        // Update cursor for year view or if no data
        if (view === 'year' || item.duration === 0) {
          bar.style.cursor = 'default'
        }

        const durationLabel = document.createElement('div')
        durationLabel.innerText = formatShortDuration(item.duration)
        durationLabel.style.fontSize = '0.85rem'
        durationLabel.style.fontWeight = 'bold'
        durationLabel.style.marginBottom = '4px'
        durationLabel.style.color = '#fff'
        durationLabel.style.visibility =
          item.duration === 0 ? 'hidden' : 'visible'
        barContainer.insertBefore(durationLabel, bar)

        const dayLabel = document.createElement('div')
        dayLabel.innerText = item.label
        dayLabel.style.fontSize = '0.85rem'
        dayLabel.style.marginTop = '8px'
        dayLabel.style.textAlign = 'center'
        barWrapper.appendChild(dayLabel)
      })
    }

    // Add button click handlers
    weekBtn.addEventListener('click', () => {
      selectedWeekOffset = 0
      selectedMonthOffset = 0
      selectedYearOffset = 0
      renderChart('week')
    })
    monthBtn.addEventListener('click', () => {
      selectedWeekOffset = 0
      selectedMonthOffset = 0
      selectedYearOffset = 0
      renderChart('month')
    })
    yearBtn.addEventListener('click', () => {
      selectedWeekOffset = 0
      selectedMonthOffset = 0
      selectedYearOffset = 0
      renderChart('year')
    })

    prevWeekBtn.addEventListener('click', () => {
      selectedWeekOffset--
      renderChart('week')
    })

    nextWeekBtn.addEventListener('click', () => {
      if (selectedWeekOffset < 0) {
        selectedWeekOffset++
        renderChart('week')
      }
    })

    prevMonthBtn.addEventListener('click', () => {
      selectedMonthOffset--
      renderChart('month')
    })

    nextMonthBtn.addEventListener('click', () => {
      if (selectedMonthOffset < 0) {
        selectedMonthOffset++
        renderChart('month')
      }
    })

    prevYearBtn.addEventListener('click', async () => {
      selectedYearOffset--
      await renderChart('year')
    })

    nextYearBtn.addEventListener('click', async () => {
      if (selectedYearOffset < 0) {
        selectedYearOffset++
        await renderChart('year')
      }
    })

    // Initial render
    await renderChart('week')
  }

  // on this day section
  async function createOnThisDaySection(row, scenes, oHistoryCache) {
    // Create main container
    const mainContainer = document.createElement('div')
    mainContainer.style.width = '100%'
    mainContainer.style.maxWidth = '1200px'
    mainContainer.style.margin = '0 auto'
    mainContainer.style.padding = '2rem 1rem'
    mainContainer.id = 'on-this-day-section'
    row.appendChild(mainContainer)

    // Track selected day offset (0 = today, -1 = yesterday, etc.)
    let selectedDayOffset = 0
    // Track expanded state
    let isExpanded = false

    // Function to render the day
    async function renderDay(dayOffset) {
      selectedDayOffset = dayOffset
      const now = new Date()
      const targetDate = new Date(now)
      targetDate.setDate(now.getDate() + dayOffset)
      const targetDay = getLocalDateString(targetDate) // YYYY-MM-DD format

      // Get day's O's from cache
      const cachedOEvents = oHistoryCache.dayMap.get(targetDay) || []

      // Collect day's O's with times for timeline display
      const dayOs = cachedOEvents.map((event) => ({
        time: new Date(event.timestamp),
        hour: new Date(event.timestamp).getHours(),
        minute: new Date(event.timestamp).getMinutes(),
        scene: event.scene,
      }))

      // Collect all events (O's and plays) for this day
      const daySceneEvents = []

      // Add O events from cache
      cachedOEvents.forEach((event) => {
        daySceneEvents.push({
          scene: event.scene,
          time: new Date(event.timestamp),
          hasO: true,
        })
      })

      // Collect play times for this day
      scenes.forEach((scene) => {
        if (scene.play_history && scene.play_history.length > 0) {
          scene.play_history.forEach((timestamp) => {
            const date = new Date(timestamp)
            const day = getLocalDateString(date)
            if (day === targetDay) {
              // Check if there's an O for THIS SPECIFIC SCENE within 30 minutes
              const hasNearbyO = daySceneEvents.some(
                (oEvent) =>
                  oEvent.hasO &&
                  oEvent.scene.id === scene.id &&
                  Math.abs(oEvent.time - date) < 1800000, // 30 minutes in ms
              )

              // Only add watch event if there's no O nearby for this scene
              if (!hasNearbyO) {
                // Also check for duplicate watch events within 30 minutes
                const hasDuplicateWatch = daySceneEvents.some(
                  (existingEvent) =>
                    !existingEvent.hasO &&
                    existingEvent.scene.id === scene.id &&
                    Math.abs(existingEvent.time - date) < 1800000,
                )

                if (!hasDuplicateWatch) {
                  daySceneEvents.push({
                    scene: scene,
                    time: date,
                    hasO: false,
                  })
                }
              }
            }
          })
        }
      })

      // Sort events by time
      daySceneEvents.sort((a, b) => a.time - b.time)

      // Sort O's by time
      dayOs.sort((a, b) => a.time - b.time)

      // Clear container
      mainContainer.innerHTML = ''

      // Header with title and navigation
      const headerContainer = document.createElement('div')
      headerContainer.style.display = 'flex'
      headerContainer.style.justifyContent = 'space-between'
      headerContainer.style.alignItems = 'center'
      headerContainer.style.marginBottom = '2rem'
      headerContainer.style.flexWrap = 'wrap'
      headerContainer.style.gap = '1rem'
      mainContainer.appendChild(headerContainer)

      const title = document.createElement('h4')
      title.innerText = tc('当日回顾', 'ON THIS DAY')
      title.style.fontSize = '1.5rem'
      title.style.margin = '0'
      title.style.flex = '1'
      title.style.textAlign = 'center'
      headerContainer.appendChild(title)

      // Day navigation
      const dayNavContainer = document.createElement('div')
      dayNavContainer.style.display = 'flex'
      dayNavContainer.style.justifyContent = 'center'
      dayNavContainer.style.alignItems = 'center'
      dayNavContainer.style.gap = '1rem'
      headerContainer.appendChild(dayNavContainer)

      const prevDayBtn = document.createElement('button')
      prevDayBtn.innerText = tc('← 上一个', '← Prev')
      prevDayBtn.style.padding = '0.25rem 0.75rem'
      prevDayBtn.style.cursor = 'pointer'
      prevDayBtn.style.border = '1px solid #555'
      prevDayBtn.style.backgroundColor = 'transparent'
      prevDayBtn.style.color = '#fff'
      prevDayBtn.style.borderRadius = '4px'
      dayNavContainer.appendChild(prevDayBtn)

      const dayLabel = document.createElement('span')
      dayLabel.style.fontSize = '1rem'
      dayLabel.style.fontWeight = 'bold'
      dayLabel.style.minWidth = '120px'
      dayLabel.style.textAlign = 'center'
      const isToday = dayOffset === 0
      if (isToday) {
        dayLabel.innerText = tc('今天', 'Today')
      } else {
        dayLabel.innerText = targetDate.toLocaleDateString(fmtDateLocale(), {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      }
      dayNavContainer.appendChild(dayLabel)

      const nextDayBtn = document.createElement('button')
      nextDayBtn.innerText = tc('下一个 →', 'Next →')
      nextDayBtn.style.padding = '0.25rem 0.75rem'
      nextDayBtn.style.cursor = 'pointer'
      nextDayBtn.style.border = '1px solid #555'
      nextDayBtn.style.backgroundColor = 'transparent'
      nextDayBtn.style.color = '#fff'
      nextDayBtn.style.borderRadius = '4px'
      nextDayBtn.disabled = dayOffset >= 0
      nextDayBtn.style.opacity = dayOffset >= 0 ? '0.5' : '1'
      nextDayBtn.style.cursor = dayOffset >= 0 ? 'not-allowed' : 'pointer'
      dayNavContainer.appendChild(nextDayBtn)

      prevDayBtn.addEventListener('click', () => {
        renderDay(selectedDayOffset - 1)
      })

      nextDayBtn.addEventListener('click', () => {
        if (selectedDayOffset < 0) {
          renderDay(selectedDayOffset + 1)
        }
      })

      // Content container (timeline + video list)
      const contentContainer = document.createElement('div')
      contentContainer.style.display = 'flex'
      contentContainer.style.gap = '2rem'
      contentContainer.style.marginBottom = '2rem'
      contentContainer.style.flexWrap = 'wrap'
      mainContainer.appendChild(contentContainer)

      // Left side: 24-hour timeline
      const timelineContainer = document.createElement('div')
      timelineContainer.style.flex = '1'
      timelineContainer.style.minWidth = '300px'
      timelineContainer.style.maxWidth = '500px'
      contentContainer.appendChild(timelineContainer)

      const timelineTitle = document.createElement('h5')
      timelineTitle.innerText = tc('时间线', 'Timeline')
      timelineTitle.style.marginBottom = '1rem'
      timelineTitle.style.fontSize = '1.1rem'
      timelineContainer.appendChild(timelineTitle)

      // Timeline visualization
      const timelineViz = document.createElement('div')
      timelineViz.style.position = 'relative'
      timelineViz.style.height = '400px'
      timelineViz.style.border = '1px solid #555'
      timelineViz.style.borderRadius = '8px'
      timelineViz.style.padding = '1rem 2rem'
      timelineViz.style.backgroundColor = 'rgba(0,0,0,0.2)'
      timelineContainer.appendChild(timelineViz)

      // Draw center vertical line
      const centerLine = document.createElement('div')
      centerLine.style.position = 'absolute'
      centerLine.style.left = '50%'
      centerLine.style.top = '1rem'
      centerLine.style.bottom = '1rem'
      centerLine.style.width = '2px'
      centerLine.style.backgroundColor = '#444'
      centerLine.style.transform = 'translateX(-50%)'
      timelineViz.appendChild(centerLine)

      // Draw hour markers (every 3 hours)
      for (let hour = 0; hour <= 24; hour += 3) {
        const markerContainer = document.createElement('div')
        markerContainer.style.position = 'absolute'
        markerContainer.style.left = '0'
        markerContainer.style.right = '0'
        markerContainer.style.top = `calc(${(hour / 24) * 100}% - 10px)`
        markerContainer.style.display = 'flex'
        markerContainer.style.alignItems = 'center'
        markerContainer.style.justifyContent = 'center'
        markerContainer.style.gap = '0.5rem'
        timelineViz.appendChild(markerContainer)

        // Convert to 12-hour format (en) or 24-hour format (zh)
        const hourLabel = document.createElement('span')
        hourLabel.innerText = formatHourLabel(hour)
        hourLabel.style.fontSize = '0.8rem'
        hourLabel.style.color = '#999'
        hourLabel.style.fontWeight =
          hour === 0 || hour === 12 ? 'bold' : 'normal'
        hourLabel.style.backgroundColor = 'rgba(0,0,0,0.5)'
        hourLabel.style.padding = '2px 6px'
        hourLabel.style.borderRadius = '3px'
        markerContainer.appendChild(hourLabel)
      }

      // Draw AM/PM background sections
      const amSection = document.createElement('div')
      amSection.style.position = 'absolute'
      amSection.style.left = '0'
      amSection.style.right = '0'
      amSection.style.top = '0'
      amSection.style.height = '50%'
      amSection.style.backgroundColor = 'rgba(255, 200, 100, 0.03)'
      amSection.style.pointerEvents = 'none'
      timelineViz.insertBefore(amSection, centerLine)

      const pmSection = document.createElement('div')
      pmSection.style.position = 'absolute'
      pmSection.style.left = '0'
      pmSection.style.right = '0'
      pmSection.style.top = '50%'
      pmSection.style.height = '50%'
      pmSection.style.backgroundColor = 'rgba(100, 150, 255, 0.03)'
      pmSection.style.pointerEvents = 'none'
      timelineViz.insertBefore(pmSection, centerLine)

      // Draw O markers with improved styling
      dayOs.forEach((o, index) => {
        const timePercent = (o.hour * 60 + o.minute) / (24 * 60)

        // Connector line from center to marker
        const connector = document.createElement('div')
        connector.style.position = 'absolute'
        connector.style.left = '50%'
        connector.style.top = `calc(${timePercent * 100}%)`
        connector.style.width = '30px'
        connector.style.height = '2px'
        connector.style.backgroundColor = '#007bff'
        connector.style.transform =
          index % 2 === 0
            ? 'translateY(-50%)'
            : 'translateY(-50%) translateX(-100%)'
        connector.style.zIndex = '5'
        timelineViz.appendChild(connector)

        const marker = document.createElement('div')
        marker.style.position = 'absolute'
        marker.style.left =
          index % 2 === 0 ? 'calc(50% + 30px)' : 'calc(50% - 50px)'
        marker.style.top = `calc(${timePercent * 100}% - 10px)`
        marker.style.width = '20px'
        marker.style.height = '20px'
        marker.style.backgroundColor = '#007bff'
        marker.style.borderRadius = '50%'
        marker.style.border = '3px solid #fff'
        marker.style.cursor = 'pointer'
        marker.style.zIndex = '10'
        marker.style.boxShadow = '0 2px 8px rgba(0, 123, 255, 0.5)'
        marker.style.transition = 'transform 0.2s, box-shadow 0.2s'

        // Format time for tooltip
        marker.title = `${formatClockTime(o.hour, o.minute)} - ${
          o.scene.title ||
          (o.scene.files && o.scene.files[0]?.basename) ||
          tc('未命名', 'Untitled')
        }`

        // Create thumbnail preview element
        const thumbnailPreview = document.createElement('div')
        thumbnailPreview.style.position = 'absolute'
        thumbnailPreview.style.top = `calc(${timePercent * 100}% - 50px)`
        thumbnailPreview.style.width = '120px'
        thumbnailPreview.style.height = '67.5px'
        thumbnailPreview.style.display = 'none'
        thumbnailPreview.style.zIndex = '100'
        thumbnailPreview.style.pointerEvents = 'none'
        thumbnailPreview.style.border = '2px solid #007bff'
        thumbnailPreview.style.borderRadius = '4px'
        thumbnailPreview.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.5)'
        thumbnailPreview.style.overflow = 'hidden'

        // Position on same side as marker
        if (index % 2 === 0) {
          // Right side
          thumbnailPreview.style.left = 'calc(50% + 60px)'
        } else {
          // Left side
          thumbnailPreview.style.left = 'calc(50% - 180px)'
        }

        const thumbnailImg = document.createElement('img')
        thumbnailImg.src = o.scene.paths.screenshot
        thumbnailImg.style.width = '100%'
        thumbnailImg.style.height = '100%'
        thumbnailImg.style.objectFit = 'cover'
        thumbnailPreview.appendChild(thumbnailImg)

        timelineViz.appendChild(thumbnailPreview)

        marker.addEventListener('mouseenter', () => {
          marker.style.transform = 'scale(1.3)'
          marker.style.boxShadow = '0 4px 12px rgba(0, 123, 255, 0.8)'
          thumbnailPreview.style.display = 'block'
        })
        marker.addEventListener('mouseleave', () => {
          marker.style.transform = 'scale(1)'
          marker.style.boxShadow = '0 2px 8px rgba(0, 123, 255, 0.5)'
          thumbnailPreview.style.display = 'none'
        })
        marker.addEventListener('click', () => {
          openSceneInNewTab(o.scene.id)
        })

        timelineViz.appendChild(marker)
      })

      // Right side: Video list
      const videoListContainer = document.createElement('div')
      videoListContainer.style.flex = '1'
      videoListContainer.style.minWidth = '300px'
      contentContainer.appendChild(videoListContainer)

      const videoListTitle = document.createElement('h5')
      videoListTitle.innerText = tc('观看的视频', 'Videos Watched')
      videoListTitle.style.marginBottom = '1rem'
      videoListTitle.style.fontSize = '1.1rem'
      videoListContainer.appendChild(videoListTitle)

      // Add expand button
      const expandButton = document.createElement('button')
      expandButton.innerText = isExpanded ? tc('收起 ▲', 'Collapse ▲') : tc('展开 ▼', 'Expand ▼')
      expandButton.style.padding = '0.5rem 1rem'
      expandButton.style.marginLeft = '1rem'
      expandButton.style.cursor = 'pointer'
      expandButton.style.border = '1px solid #555'
      expandButton.style.backgroundColor = 'transparent'
      expandButton.style.color = '#fff'
      expandButton.style.borderRadius = '4px'
      expandButton.style.fontSize = '0.9rem'
      expandButton.addEventListener('click', () => {
        isExpanded = !isExpanded
        renderDay(selectedDayOffset)
      })
      videoListTitle.appendChild(expandButton)

      const videoList = document.createElement('div')
      videoList.style.maxHeight = isExpanded ? '800px' : '400px'
      videoList.style.overflowY = 'auto'
      videoList.style.border = '1px solid #555'
      videoList.style.borderRadius = '8px'
      videoList.style.backgroundColor = 'rgba(0,0,0,0.2)'
      videoListContainer.appendChild(videoList)

      // Add videos to list
      if (daySceneEvents.length === 0) {
        const emptyMsg = document.createElement('div')
        emptyMsg.style.padding = '2rem'
        emptyMsg.style.textAlign = 'center'
        emptyMsg.style.color = '#888'
        emptyMsg.innerText = tc('当天没有观看视频', 'No videos watched on this day')
        videoList.appendChild(emptyMsg)
      } else {
        // Load watch time data
        const watchTimeData = await loadWatchTimeData()
        const targetDayWatchData = watchTimeData[targetDay]
        const isToday = dayOffset === 0

        // Duration formatting is localized via formatShortDuration

        daySceneEvents.forEach(({ scene, time, hasO }) => {
          const videoItem = document.createElement('div')
          videoItem.style.display = 'flex'
          videoItem.style.gap = '1rem'
          videoItem.style.padding = '0.75rem'
          videoItem.style.borderBottom = '1px solid #333'
          videoItem.style.alignItems = 'center'
          videoItem.style.transition = 'background-color 0.2s'
          videoItem.style.cursor = 'pointer'
          videoItem.style.position = 'relative'
          if (hasO) {
            videoItem.style.border = '2px solid #007bff'
            videoItem.style.borderRadius = '4px'
            videoItem.style.marginBottom = '0.5rem'
          }
          videoList.appendChild(videoItem)

          videoItem.addEventListener('mouseenter', () => {
            videoItem.style.backgroundColor = 'rgba(255,255,255,0.05)'
          })
          videoItem.addEventListener('mouseleave', () => {
            videoItem.style.backgroundColor = 'transparent'
          })

          videoItem.addEventListener('click', () => {
            openSceneInNewTab(scene.id)
          })

          const thumbnail = document.createElement('img')
          thumbnail.src = scene.paths.screenshot
          thumbnail.style.width = '80px'
          thumbnail.style.height = '45px'
          thumbnail.style.objectFit = 'cover'
          thumbnail.style.borderRadius = '4px'
          thumbnail.style.flexShrink = '0'
          videoItem.appendChild(thumbnail)

          const infoContainer = document.createElement('div')
          infoContainer.style.flex = '1'
          infoContainer.style.minWidth = '0'
          videoItem.appendChild(infoContainer)

          const sceneTitle = document.createElement('div')
          sceneTitle.innerText =
            scene.title ||
            (scene.files && scene.files[0]?.basename) ||
            tc('未命名', 'Untitled')
          sceneTitle.style.fontSize = '0.9rem'
          sceneTitle.style.fontWeight = 'bold'
          sceneTitle.style.marginBottom = '0.25rem'
          sceneTitle.style.overflow = 'hidden'
          sceneTitle.style.textOverflow = 'ellipsis'
          sceneTitle.style.whiteSpace = 'nowrap'
          infoContainer.appendChild(sceneTitle)

          const sceneInfo = document.createElement('div')
          sceneInfo.style.fontSize = '0.75rem'
          sceneInfo.style.color = '#888'
          // Format time (12-hour for en, 24-hour for zh)
          const timeStr = formatClockTime(time.getHours(), time.getMinutes())

          // Check if this scene has watch time on this day
          let watchTimeText = timeStr
          if (targetDayWatchData && targetDayWatchData.videos) {
            const videoData = targetDayWatchData.videos.find(
              (v) => String(v.id) === String(scene.id),
            )
            if (videoData && videoData.watchTime > 0) {
              const formattedTime = formatShortDuration(videoData.watchTime)
              watchTimeText = isToday
                ? tc(`${timeStr} - 今日观看 ${formattedTime}`, `${timeStr} - ${formattedTime} watched today`)
                : tc(`${timeStr} - 当日观看 ${formattedTime}`, `${timeStr} - ${formattedTime} watched on this day`)
            }
          }

          sceneInfo.innerText = watchTimeText
          infoContainer.appendChild(sceneInfo)

          // Add O emoji if this event has an O
          if (hasO) {
            const oEmoji = document.createElement('div')
            oEmoji.innerText = '💦'
            oEmoji.style.fontSize = '1.5rem'
            oEmoji.style.flexShrink = '0'
            videoItem.appendChild(oEmoji)
          }
        })
      }

      // Summary section at bottom
      const summaryContainer = document.createElement('div')
      summaryContainer.style.display = 'flex'
      summaryContainer.style.justifyContent = 'center'
      summaryContainer.style.gap = '3rem'
      summaryContainer.style.padding = '1.5rem'
      summaryContainer.style.borderTop = '2px solid #555'
      summaryContainer.style.marginTop = '1rem'
      mainContainer.appendChild(summaryContainer)

      // Total O's today
      const oSummary = document.createElement('div')
      oSummary.style.textAlign = 'center'
      summaryContainer.appendChild(oSummary)

      const oCount = document.createElement('div')
      oCount.innerText = dayOs.length
      oCount.style.fontSize = '2rem'
      oCount.style.fontWeight = 'bold'
      oCount.style.color = '#007bff'
      oSummary.appendChild(oCount)

      const oLabel = document.createElement('div')
      oLabel.innerText = tc("O 总数", "Total O's")
      oLabel.style.fontSize = '0.9rem'
      oLabel.style.color = '#888'
      oLabel.style.marginTop = '0.25rem'
      oSummary.appendChild(oLabel)

      // Total watch time for the day
      const watchTimeData = await loadWatchTimeData()
      const dayData = watchTimeData[targetDay]
      // Simplified format: just numbers (with migration from old format)
      let watchTimeSeconds = 0
      if (dayData) {
        if (typeof dayData === 'object' && 'totalTime' in dayData) {
          // Migrate old format
          watchTimeSeconds = dayData.totalTime || 0
        } else {
          watchTimeSeconds = dayData || 0
        }
      }

      const watchTimeSummary = document.createElement('div')
      watchTimeSummary.style.textAlign = 'center'
      summaryContainer.appendChild(watchTimeSummary)

      const watchTimeDisplay = document.createElement('div')
      // Format duration for display
      const watchTimeText = formatShortDuration(watchTimeSeconds)
      watchTimeDisplay.innerText = watchTimeText
      watchTimeDisplay.style.fontSize = '2rem'
      watchTimeDisplay.style.fontWeight = 'bold'
      watchTimeDisplay.style.color = '#28a745'
      watchTimeSummary.appendChild(watchTimeDisplay)

      const watchTimeLabel = document.createElement('div')
      watchTimeLabel.innerText = tc('观看时长', 'Watch Time')
      watchTimeLabel.style.fontSize = '0.9rem'
      watchTimeLabel.style.color = '#888'
      watchTimeLabel.style.marginTop = '0.25rem'
      watchTimeSummary.appendChild(watchTimeLabel)

      // Videos watched stat
      const videosWatchedSummary = document.createElement('div')
      videosWatchedSummary.style.textAlign = 'center'
      summaryContainer.appendChild(videosWatchedSummary)

      const videosWatchedCount = document.createElement('div')
      // Count unique scenes only
      const uniqueScenes = new Set(
        daySceneEvents.map((event) => event.scene.id),
      )
      videosWatchedCount.innerText = uniqueScenes.size
      videosWatchedCount.style.fontSize = '2rem'
      videosWatchedCount.style.fontWeight = 'bold'
      videosWatchedCount.style.color = '#ffc107'
      videosWatchedSummary.appendChild(videosWatchedCount)

      const videosWatchedLabel = document.createElement('div')
      videosWatchedLabel.innerText = tc('观看的视频', 'Videos Watched')
      videosWatchedLabel.style.fontSize = '0.9rem'
      videosWatchedLabel.style.color = '#888'
      videosWatchedLabel.style.marginTop = '0.25rem'
      videosWatchedSummary.appendChild(videosWatchedLabel)

      // Average minutes per O for this day (Mean Jerk Time)
      // Only show if there are O's this day
      if (dayOs.length > 0) {
        const avgMinPerOSummary = document.createElement('div')
        avgMinPerOSummary.style.textAlign = 'center'
        summaryContainer.appendChild(avgMinPerOSummary)

        const avgMinPerODisplay = document.createElement('div')
        // Calculate average minutes per O for this specific day
        const totalOsThisDay = dayOs.length
        const watchTimeMinutes = watchTimeSeconds / 60
        let avgMinPerO = 0
        if (totalOsThisDay > 0) {
          avgMinPerO = watchTimeMinutes / totalOsThisDay
        }

        // Format as hours and minutes like other time displays
        let avgDisplayText = tc('0分', '0m')
        if (avgMinPerO > 0) {
          const avgHours = Math.floor(avgMinPerO / 60)
          const avgMins = Math.floor(avgMinPerO % 60)
          if (avgHours > 0) {
            avgDisplayText = tc(`${avgHours}时 ${avgMins}分`, `${avgHours}h ${avgMins}m`)
          } else {
            avgDisplayText = tc(`${avgMins}分`, `${avgMins}m`)
          }
        }

        avgMinPerODisplay.innerText = avgDisplayText
        avgMinPerODisplay.style.fontSize = '2rem'
        avgMinPerODisplay.style.fontWeight = 'bold'
        avgMinPerODisplay.style.color = '#dc3545'
        avgMinPerOSummary.appendChild(avgMinPerODisplay)

        const avgMinPerOLabel = document.createElement('div')
        avgMinPerOLabel.innerText = tc('平均分钟/O', 'Avg min/O')
        avgMinPerOLabel.style.fontSize = '0.9rem'
        avgMinPerOLabel.style.color = '#888'
        avgMinPerOLabel.style.marginTop = '0.25rem'
        avgMinPerOSummary.appendChild(avgMinPerOLabel)
      }
    }

    // Initial render with today
    renderDay(0)

    // Store the render function globally so graphs can trigger it
    window.onThisDayRender = renderDay
  }

  PathElementListener('/stats', 'div.container-fluid div.mt-5', setupStats)
  async function setupStats(el) {
    if (document.querySelector('.custom-stats-row')) return
    const changelog = el.querySelector('div.changelog')

    // Create visual separator before O Stats
    const separator = document.createElement('hr')
    separator.style.margin = '4rem auto'
    separator.style.width = '80%'
    separator.style.border = 'none'
    separator.style.borderTop = '2px solid rgba(255, 255, 255, 0.2)'
    el.insertBefore(separator, changelog)

    // Create header container
    const headerContainer = document.createElement('div')
    headerContainer.style.marginTop = '2rem'
    headerContainer.style.marginBottom = '2rem'
    headerContainer.style.display = 'flex'
    headerContainer.style.justifyContent = 'center'
    headerContainer.style.alignItems = 'center'
    el.insertBefore(headerContainer, changelog)

    const oStatsHeader = document.createElement('h3')
    oStatsHeader.style.fontSize = '3rem'
    oStatsHeader.style.margin = '0'
    oStatsHeader.innerText = ''
    headerContainer.appendChild(oStatsHeader)

    const rowOne = document.createElement('div')
    rowOne.classList = 'custom-stats-row col col-sm-8 m-sm-auto row stats'
    rowOne.style.justifyContent = 'center'
    rowOne.style.marginTop = '1rem'
    el.insertBefore(rowOne, changelog)
    const rowTwo = document.createElement('div')
    rowTwo.classList = 'custom-stats-row col col-sm-8 m-sm-auto row stats'
    rowTwo.style.justifyContent = 'center'
    rowTwo.style.gap = '1rem'
    rowTwo.style.paddingTop = '2rem'
    el.insertBefore(rowTwo, changelog)
    const rowThree = document.createElement('div')
    rowThree.classList = 'custom-stats-row col col-sm-8 m-sm-auto row stats'
    rowThree.style.justifyContent = 'center'
    rowThree.style.paddingTop = '4rem'
    el.insertBefore(rowThree, changelog)
    const rowFour = document.createElement('div')
    rowFour.classList = 'custom-stats-row col col-sm-8 m-sm-auto row stats'
    rowFour.style.justifyContent = 'center'
    rowFour.style.paddingTop = '4rem'
    el.insertBefore(rowFour, changelog)
    const rowFive = document.createElement('div')
    rowFive.classList = 'custom-stats-row col col-sm-8 m-sm-auto row stats'
    rowFive.style.justifyContent = 'center'
    rowFive.style.paddingTop = '2rem'
    el.insertBefore(rowFive, changelog)
    const rowSix = document.createElement('div')
    rowSix.classList = 'custom-stats-row col col-sm-8 m-sm-auto row stats'
    rowSix.style.justifyContent = 'center'
    rowSix.style.paddingTop = '4rem'
    rowSix.style.paddingBottom = '12rem'
    el.insertBefore(rowSix, changelog)

    // Fast path: load lightweight stats data first.
    const [scenes, watchTimeData] = await Promise.all([
      getScenesWithOHistory(),
      loadWatchTimeData(),
    ])

    // OPTIMIZATION: Pre-process O history for faster lookups
    const oHistoryCache = buildOHistoryDayMap(scenes)

    // OPTIMIZATION: Run all stat calculations in parallel
    await Promise.all([
      createOrgasmsToday(rowOne, scenes, oHistoryCache),
      createBestOrgasmDay(rowOne, scenes, oHistoryCache),
      createOrgasmStreak(rowOne, scenes, oHistoryCache),
      createWatchTimeToday(rowOne, watchTimeData),
      createAverageOPerMinute(rowOne, scenes, watchTimeData, oHistoryCache),
    ])

    await Promise.all([
      createMostOScene(rowTwo, scenes),
      createLongestWatchedScene(rowTwo, scenes),
      createMostRecentOScene(rowTwo, scenes),
      createOldestOScene(rowTwo, scenes),
    ])

    await createWeeklyBarChart(rowThree, scenes, oHistoryCache)
    await createWatchTimeBarChart(rowFour, watchTimeData)
    createWatchTimeExportButton(rowFive, scenes)

    const onThisDayLoading = document.createElement('div')
    onThisDayLoading.style.textAlign = 'center'
    onThisDayLoading.style.width = '100%'
    onThisDayLoading.style.color = '#888'
    onThisDayLoading.style.padding = '2rem 1rem'
    onThisDayLoading.innerText = tc('正在加载当日数据...', 'Loading On This Day...')
    rowSix.appendChild(onThisDayLoading)

    // Heavy path: fetch full play history in background and hydrate the section.
    getScenesWithPlayHistory()
      .then(async (fullScenes) => {
        rowSix.innerHTML = ''
        const fullHistoryCache = buildOHistoryDayMap(fullScenes)
        await createOnThisDaySection(rowSix, fullScenes, fullHistoryCache)
      })
      .catch((err) => {
        console.error('[oStatsI18n] Failed loading On This Day data:', err)
        onThisDayLoading.innerText = tc('加载当日数据失败。', 'Failed to load On This Day data.')
      })

    // Create bottom footer with cache toggle
    const footerContainer = document.createElement('div')
    footerContainer.style.marginTop = '4rem'
    footerContainer.style.marginBottom = '2rem'
    footerContainer.style.display = 'flex'
    footerContainer.style.justifyContent = 'center'
    footerContainer.style.alignItems = 'center'
    footerContainer.style.gap = '0.5rem'
    footerContainer.style.fontSize = '0.9rem'
    el.insertBefore(footerContainer, changelog)

    const cacheCheckbox = document.createElement('input')
    cacheCheckbox.type = 'checkbox'
    cacheCheckbox.checked = shouldUseCache()
    cacheCheckbox.style.cursor = 'pointer'
    footerContainer.appendChild(cacheCheckbox)

    const cacheLabel = document.createElement('label')
    cacheLabel.innerText = tc('使用缓存', 'Use cache')
    cacheLabel.style.cursor = 'pointer'
    cacheLabel.style.userSelect = 'none'
    footerContainer.appendChild(cacheLabel)

    const helpIcon = document.createElement('div')
    helpIcon.innerText = '?'
    helpIcon.style.width = '18px'
    helpIcon.style.height = '18px'
    helpIcon.style.borderRadius = '50%'
    helpIcon.style.backgroundColor = '#555'
    helpIcon.style.color = '#ccc'
    helpIcon.style.display = 'flex'
    helpIcon.style.alignItems = 'center'
    helpIcon.style.justifyContent = 'center'
    helpIcon.style.fontSize = '0.75rem'
    helpIcon.style.fontWeight = 'bold'
    helpIcon.style.cursor = 'help'
    helpIcon.style.transition = 'background-color 0.2s, color 0.2s'
    helpIcon.title = tc('启用后统计数据将缓存 10 分钟以加快加载；禁用后始终加载最新数据。您的偏好会被保存。', 'When enabled, stats are cached for 10 minutes to load faster. When disabled, stats always load fresh. Your preference is saved.')
    helpIcon.addEventListener('mouseenter', () => {
      helpIcon.style.backgroundColor = '#666'
      helpIcon.style.color = '#fff'
    })
    helpIcon.addEventListener('mouseleave', () => {
      helpIcon.style.backgroundColor = '#555'
      helpIcon.style.color = '#ccc'
    })
    footerContainer.appendChild(helpIcon)

    // Save preference when checkbox changes
    cacheCheckbox.addEventListener('change', () => {
      setShouldUseCache(cacheCheckbox.checked)
    })
  }
})()
