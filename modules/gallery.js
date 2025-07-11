/**
 * Gallery module - Handles artist gallery display and image management
 */

import { createFullscreenViewer, createSpinner } from "./ui.js";
import { fetchArtistImages, clearArtistCache, buildImageUrl } from "./api.js";
import { handleArtistCopy } from "./sidebar.js";

// Gallery state
let currentArtistPage = 0;
const artistsPerPage = 24;
let filtered = [];
let isFetching = false;
let sortMode = "name";
let filterGeneration = 0;

// DOM references
let artistGallery = null;
let backgroundBlur = null;

// External dependencies
let allArtists = [];
let getActiveTags = null;
let getArtistNameFilter = null;

/**
 * Sets the background image with a random image
 */
async function setRandomBackground() {
  if (!backgroundBlur) return;

  try {
    if (document.body.classList.contains("incognito-theme")) {
      backgroundBlur.style.backgroundImage = "none";
      backgroundBlur.style.backgroundColor = "#111";
      return;
    }

    const { getRandomBackgroundImage } = await import("./api.js");
    const imageUrl = await getRandomBackgroundImage();

    if (imageUrl) {
      backgroundBlur.style.backgroundImage = `url(${imageUrl})`;
    } else {
      backgroundBlur.style.backgroundColor = "#111";
    }
  } catch (error) {
    console.warn("Failed to set random background:", error);
    backgroundBlur.style.backgroundColor = "#111";
  }
}

/**
 * Sets the best image for an artist with caching and lazy loading
 */
function setBestImage(artist, img) {
  const cacheKey = `danbooru-image-${artist.artistName}`;
  const cachedUrl = localStorage.getItem(cacheKey);

  // Get selected tags for filtering
  const selectedTags = getActiveTags ? Array.from(getActiveTags()) : [];

  // Session storage cache for API results
  const apiCacheKey = `danbooru-api-${artist.artistName}-${selectedTags.join(
    ","
  )}`;

  function getApiCache() {
    const cached = sessionStorage.getItem(apiCacheKey);
    if (!cached) return null;
    try {
      return JSON.parse(cached);
    } catch {
      return null;
    }
  }

  function setApiCache(data) {
    try {
      sessionStorage.setItem(apiCacheKey, JSON.stringify(data));
    } catch {}
  }

  function showNoEntries() {
    img.style.display = "none";
    img.src = "fallback.jpg";
    setTimeout(() => {
      img.style.display = "block";
    }, 100);
  }

  function processApiData(data, isFallback = false) {
    const validPosts = Array.isArray(data)
      ? data.filter((post) => {
          const url = post?.large_file_url || post?.file_url;
          const isImage = url && /\.(jpg|jpeg|png|gif)$/i.test(url);
          return isImage && !post.is_banned;
        })
      : [];

    if (validPosts.length === 0) {
      if (!isFallback && selectedTags.length > 0) {
        // Retry using only the artist name ordered by score
        fetchArtistImages(artist.artistName)
          .then((fallbackData) => {
            processApiData(fallbackData, true);
          })
          .catch(() => {
            showNoEntries();
          });
      } else {
        showNoEntries();
      }
      return;
    }

    function tryLoadUrls(urls, index = 0) {
      if (index >= urls.length) {
        showNoEntries();
        return;
      }
      const url = urls[index];
      img.onerror = () => tryLoadUrls(urls, index + 1);
      img.onload = () => {
        img.onerror = null;
        img.onload = null;
        if (index === 0) {
          localStorage.setItem(cacheKey, url);
        }
        artist._thumbnailPostId = validPosts[index]?.id;
      };
      img.src = url;
    }

    const imageUrls = validPosts
      .slice(0, 5)
      .map((post) => {
        const url = post.large_file_url || post.file_url;
        return buildImageUrl(url);
      })
      .filter(Boolean);

    if (imageUrls.length > 0) {
      tryLoadUrls(imageUrls);
    } else {
      showNoEntries();
    }
  }

  // Try cached image first
  if (cachedUrl) {
    img.onerror = fetchAndTry;
    img.onload = () => {
      img.onerror = null;
      img.onload = null;
    };
    img.src = cachedUrl;
  } else {
    fetchAndTry();
  }

  function fetchAndTry() {
    const cached = getApiCache();
    if (cached) {
      processApiData(cached);
      return;
    }

    fetchArtistImages(artist.artistName, selectedTags)
      .then((data) => {
        setApiCache(data);
        processApiData(data);
      })
      .catch(() => {
        img.src = "fallback.jpg";
      });
  }
}

/**
 * Lazy loads the best image for an artist
 */
function lazyLoadBestImage(artist, img) {
  const observer = new IntersectionObserver(
    (entries, obs) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          setBestImage(artist, img);
          obs.unobserve(entry.target);
        }
      });
    },
    { rootMargin: "50px" }
  );
  observer.observe(img);
}

/**
 * Opens the fullscreen artist zoom view
 */
async function openArtistZoom(artist) {
  // Remove any existing fullscreen viewer
  document.querySelectorAll(".fullscreen-wrapper").forEach((el) => el.remove());

  const viewer = createFullscreenViewer();
  const {
    wrapper,
    img: zoomed,
    tagList,
    topTags,
    noEntriesMsg,
    prevBtn,
    nextBtn,
  } = viewer;

  let currentIndex = 0;
  let posts = [];

  // In-memory cache for top tags (limit to 20 artists per session)
  const topTagsCache = new Map();
  const TOP_TAGS_CACHE_LIMIT = 20;

  async function fetchAllArtistImages(artistName, selectedTags = []) {
    const cacheKey = `${artistName}-${selectedTags.join(",")}`;
    if (topTagsCache.has(cacheKey)) return topTagsCache.get(cacheKey);
    let allPosts = [];
    const MAX_PAGES = 20; // Limit to 5 pages (500 posts)
    const LIMIT = 200;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const pagePosts = await fetchArtistImages(artistName, selectedTags, {
        page,
        limit: LIMIT,
      });
      if (!pagePosts || pagePosts.length === 0) break;
      allPosts = allPosts.concat(pagePosts);
    }
    // Limit cache size
    if (topTagsCache.size >= TOP_TAGS_CACHE_LIMIT) {
      const firstKey = topTagsCache.keys().next().value;
      topTagsCache.delete(firstKey);
    }
    topTagsCache.set(cacheKey, allPosts);
    return allPosts;
  }

  function showNoEntries() {
    zoomed.style.display = "none";
    noEntriesMsg.style.display = "block";
    noEntriesMsg.textContent = "No tags found.";
    // Add Retry button if not present
    if (!noEntriesMsg.querySelector(".retry-btn")) {
      const retryBtn = document.createElement("button");
      retryBtn.className = "retry-btn";
      retryBtn.textContent = "Retry";
      retryBtn.setAttribute("aria-label", "Retry loading tags");
      retryBtn.onclick = () => {
        // Clear sessionStorage for this artist's tags
        const cacheKey = `allPosts-${artist.artistName}-${
          getActiveTags ? Array.from(getActiveTags()).join(",") : ""
        }`;
        sessionStorage.removeItem(cacheKey);
        noEntriesMsg.textContent = "Retrying...";
        // Re-run the zoom modal logic
        openArtistZoom(artist);
      };
      noEntriesMsg.appendChild(retryBtn);
    }
  }

  function tryShow(index, attempts = 0) {
    if (!posts.length || attempts >= posts.length) {
      showNoEntries();
      return;
    }
    const raw = posts[index];
    const url = raw?.large_file_url || raw?.file_url;
    const full = buildImageUrl(url);
    zoomed.style.opacity = "0.5";
    zoomed.src = "";
    noEntriesMsg.style.display = "none";
    zoomed.onerror = () => {
      tryShow((index + 1) % posts.length, attempts + 1);
    };
    zoomed.onload = () => {
      zoomed.style.display = "block";
      zoomed.style.opacity = "1";
      noEntriesMsg.style.display = "none";
      zoomed.onerror = null;
      zoomed.onload = null;
      if (tagList && raw.tag_string) {
        tagList.textContent = raw.tag_string.split(" ").join(", ");
        tagList.style.display = "block";
      }
      if (topTags && topTags.textContent) {
        topTags.style.display = "block";
      }
    };
    zoomed.src = full;
  }

  let navTimeout;
  function debouncedShowPost(i) {
    clearTimeout(navTimeout);
    navTimeout = setTimeout(() => tryShow(i), 80);
  }

  prevBtn.onclick = () => {
    currentIndex = (currentIndex - 1 + posts.length) % posts.length;
    debouncedShowPost(currentIndex);
  };

  nextBtn.onclick = () => {
    currentIndex = (currentIndex + 1) % posts.length;
    debouncedShowPost(currentIndex);
  };

  document.body.appendChild(wrapper);
  wrapper.focus();

  // Fetch and show artist images
  try {
    const data = await fetchArtistImages(artist.artistName);
    if (!Array.isArray(data)) {
      posts = [];
      showNoEntries();
      return;
    }

    const validPosts = data.filter((post) => {
      const url = post?.large_file_url || post?.file_url;
      const isImage = url && /\.(jpg|jpeg|png|gif)$/i.test(url);
      return isImage && !post.is_banned;
    });

    posts = validPosts;
    if (posts.length === 0) {
      showNoEntries();
      return;
    }
    // compute artist top tags
    try {
      // Count all tags
      const allPosts = await fetchAllArtistImages(artist.artistName);
      if (!Array.isArray(allPosts) || allPosts.length === 0) {
        if (topTags) topTags.textContent = "No tags found.";
      } else {
        const counts = {};
        allPosts.forEach((p) => {
          (p.tag_string || "").split(" ").forEach((t) => {
            counts[t] = (counts[t] || 0) + 1;
          });
        });
        // Get selected tags from filter (if any)
        const selectedTags = getActiveTags ? Array.from(getActiveTags()) : [];
        const selectedCounts = selectedTags
          .map((tag) => {
            const count = counts[tag] || 0;
            return `${tag.replace(/_/g, " ")} (${count})`;
          })
          .filter((str) => !str.startsWith(" (0)")); // Hide tags with 0 count

        // Top 20 overall tags (excluding selected tags)
        const top = Object.entries(counts)
          .filter(([t]) => !selectedTags.includes(t))
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([t, c]) => `${t.replace(/_/g, " ")} (${c})`);

        // Combine selected tags first, then top tags
        const tagString = [
          ...(selectedCounts.length ? selectedCounts : []),
          ...(top.length ? top : []),
        ].join(", ");

        if (topTags) topTags.textContent = tagString || "No tags found.";
      }
    } catch (err) {
      if (topTags) topTags.textContent = "Error loading tags.";
      console.warn("Failed to compute top tags:", err);
    }

    const startId = artist._thumbnailPostId;
    const idx = startId ? posts.findIndex((p) => p.id === startId) : -1;
    currentIndex = idx >= 0 ? idx : 0;
    tryShow(currentIndex);
  } catch (error) {
    console.warn("Failed to fetch artist images:", error);
    showNoEntries();
    if (topTags) topTags.textContent = "Error loading tags.";
  }

  // After you set tagList.textContent and topTags.textContent:
  tagList.style.display = "block";
  topTags.style.display = "block";
  tagList.setAttribute("aria-live", "polite");
  topTags.setAttribute("aria-live", "polite");
  zoomed.setAttribute("tabindex", "0");
  zoomed.setAttribute("aria-label", "Artist image, click to toggle tags");
}

/**
 * Renders the current page of artists
 */
function renderArtistsPage() {
  if (!artistGallery) return;

  // Only clear on first page
  if (currentArtistPage === 0) {
    artistGallery.innerHTML = "";
  }

  // Remove spinner if present
  const spinner = artistGallery.querySelector(".gallery-spinner");
  if (spinner) spinner.remove();

  // DO NOT clear artistGallery here!
  // artistGallery.innerHTML = ""; // <-- REMOVE THIS LINE

  if (filtered.length === 0) {
    const msg = document.createElement("div");
    msg.className = "no-artists-msg";
    msg.textContent = "No artists found for this filter.";
    artistGallery.appendChild(msg);
    return;
  }

  const start = currentArtistPage * artistsPerPage;
  const end = start + artistsPerPage;
  const artistsToShow = filtered.slice(start, end);

  artistsToShow.forEach((artist) => {
    const card = document.createElement("div");
    card.className = "artist-card";

    const img = document.createElement("img");
    img.className = "artist-image";
    lazyLoadBestImage(artist, img);

    // Fullscreen zoom on image click
    img.addEventListener("click", () => openArtistZoom(artist));

    const name = document.createElement("div");
    name.className = "artist-name";
    name.textContent = artist.artistName.replace(/_/g, " ");

    // Improved count display logic
    artist._updateCountDisplay = function () {
      const hasTagFilter = getActiveTags && getActiveTags().size > 0;
      const total =
        typeof this._totalImageCount === "number"
          ? this._totalImageCount
          : typeof this.postCount === "number"
          ? this.postCount
          : undefined;

      if (
        hasTagFilter &&
        typeof this._imageCount === "number" &&
        typeof total === "number"
      ) {
        name.textContent = `${this.artistName.replace(/_/g, " ")} [${
          this._imageCount
        }/${total}]`;
      } else if (typeof total === "number") {
        name.textContent = `${this.artistName.replace(/_/g, " ")} [${total}]`;
      } else {
        name.textContent = `${this.artistName.replace(/_/g, " ")} [Loading…]`;
      }
    };

    artist._updateCountDisplay();

    // When counts are set later, call this function
    Object.defineProperty(artist, "_imageCount", {
      set(val) {
        this.__imageCount = val;
        if (typeof this._updateCountDisplay === "function")
          this._updateCountDisplay();
      },
      get() {
        return this.__imageCount;
      },
      configurable: true,
    });
    Object.defineProperty(artist, "_totalImageCount", {
      set(val) {
        this.__totalImageCount = val;
        if (typeof this._updateCountDisplay === "function")
          this._updateCountDisplay();
      },
      get() {
        return this.__totalImageCount;
      },
      configurable: true,
    });

    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-button";
    copyBtn.textContent = "📋";
    copyBtn.title = "Copy name";
    copyBtn.onclick = () => handleArtistCopy(artist, img.src);

    const reloadBtn = document.createElement("button");
    reloadBtn.className = "reload-button";
    reloadBtn.textContent = "⟳";
    reloadBtn.title = "Reload artist images/count";
    reloadBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      // Clear cache for this artist
      if (typeof clearArtistCache === "function")
        clearArtistCache(artist.artistName);
      // Also clear sessionStorage for top tags
      const cacheKey = `allPosts-${artist.artistName}-${
        getActiveTags ? Array.from(getActiveTags()).join(",") : ""
      }`;
      sessionStorage.removeItem(cacheKey);
      // Reset counts
      artist._imageCount = undefined;
      artist._totalImageCount = undefined;
      // Optionally show loading state
      name.textContent = artist.artistName.replace(/_/g, " ") + " [Loading…]";
      // Force re-fetch and re-render
      setTimeout(() => {
        if (typeof filterArtists === "function") {
          filterArtists(true, true); // force reload and re-render
        }
      }, 100);
    });

    // Show tags if available
    if (artist.kinkTags && artist.kinkTags.length > 0) {
      const taglist = document.createElement("div");
      taglist.className = "artist-tags";
      taglist.textContent = artist.kinkTags.join(", ");
      card.append(img, name, taglist, copyBtn, reloadBtn);
    } else {
      card.append(img, name, copyBtn, reloadBtn);
    }

    artistGallery.appendChild(card);
  });
  currentArtistPage++;
}

/**
 * Filters and displays artists based on current criteria
 */
async function filterArtists(reset = true, force = false) {
  if (!artistGallery) return;
  const generation = ++filterGeneration;
  if (isFetching) {
    const existing = artistGallery.querySelector(".gallery-spinner");
    if (!existing) {
      artistGallery.appendChild(createSpinner());
    }
  }

  let spinner;
  try {
    if (reset) {
      currentArtistPage = 0;
      artistGallery.innerHTML = "";
    }

    spinner = artistGallery.querySelector(".gallery-spinner");
    if (!spinner) {
      spinner = createSpinner();
      artistGallery.appendChild(spinner);
    } else if (!spinner.updateProgress) {
      spinner.remove();
      spinner = createSpinner();
      artistGallery.appendChild(spinner);
    }

    isFetching = true;

    // Get active tags and filters
    const activeTags = getActiveTags ? getActiveTags() : new Set();
    const artistNameFilter = getArtistNameFilter ? getArtistNameFilter() : "";

    // Filter artists
    filtered = allArtists.filter((artist) => {
      const tags = artist.kinkTags || [];
      return (
        Array.from(activeTags).every((tag) => tags.includes(tag)) &&
        (artist.artistName.toLowerCase().includes(artistNameFilter) ||
          artistNameFilter === "")
      );
    });

    if (spinner.setTotal) spinner.setTotal(filtered.length);
    if (spinner.updateProgress) spinner.updateProgress(0);

    // Always fetch counts for the current filtered artists
    async function fetchInBatches(
      artists,
      batchSize = 5,
      delayMs = 1000,
      gen,
      spin
    ) {
      let done = 0;
      for (let i = 0; i < artists.length; i += batchSize) {
        if (gen !== filterGeneration) return;
        const batch = artists.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async (artist) => {
            const totalCount = artist.postCount || 0;
            artist._totalImageCount = totalCount;
            artist._imageCount = totalCount;
            if (gen !== filterGeneration) {
              return;
            }
          })
        );

        done += batch.length;
        if (spin && spin.updateProgress) spin.updateProgress(done);

        if (i + batchSize < artists.length) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      if (gen !== filterGeneration) return;

      setSortMode(sortMode);
      renderArtistsPage();
    }

    renderArtistsPage(); // Render immediately

    if (reset) {
      await fetchInBatches(filtered, 5, 1000, generation, spinner).catch(
        (e) => {
          console.error("Batch fetch failed:", e);
        }
      );
      if (generation !== filterGeneration) return;
      setSortMode(sortMode);
      renderArtistsPage();
    } else if (force) {
      fetchInBatches(filtered, 5, 1000, generation, spinner).then(() => {
        if (generation !== filterGeneration) return;
        setSortMode(sortMode);
        renderArtistsPage();
      });
    }
  } catch (error) {
    console.warn("filterArtists failed", error);
  } finally {
    if (generation === filterGeneration) {
      const remaining = artistGallery.querySelector(".gallery-spinner");
      if (remaining) remaining.remove();
      isFetching = false;
    }
  }
}

function initGallery() {
  artistGallery = document.getElementById("artist-gallery");
  backgroundBlur = document.getElementById("background-blur");
}
function getPaginationInfo() {
  const total = filtered.length;
  const shown = currentArtistPage * artistsPerPage;
  return {
    total,
    shown,
    hasMore: shown < total,
    currentPage: currentArtistPage,
    artistsPerPage,
  };
}

function setAllArtists(artists) {
  allArtists = artists;
}

function setGetActiveTagsCallback(callback) {
  getActiveTags = callback;
}

/**
 * Sets the callback to get artist name filter
 */
function setGetArtistNameFilterCallback(callback) {
  getArtistNameFilter = callback;
}

function setSortMode(mode) {
  sortMode = mode === "count" ? "count" : "name";
  if (filtered.length > 0) {
    if (sortMode === "count") {
      filtered.sort(
        (a, b) => (b._totalImageCount || 0) - (a._totalImageCount || 0)
      );
    } else {
      filtered.sort((a, b) =>
        a.artistName.localeCompare(b.artistName, undefined, {
          sensitivity: "base",
        })
      );
    }
    currentArtistPage = 0;
    renderArtistsPage();
  }
}
function setSortPreference(preference) {
  sortMode = preference === "count" ? "count" : "name";
}

function forceSortAndRender() {
  setSortMode(sortMode);
}

function getFilteredArtists() {
  return [...filtered];
}

export {
  initGallery,
  filterArtists,
  renderArtistsPage,
  openArtistZoom,
  setSortPreference,
  forceSortAndRender,
  setRandomBackground,
  setAllArtists,
  setGetActiveTagsCallback,
  setGetArtistNameFilterCallback,
  setSortMode,
  getFilteredArtists,
  getPaginationInfo,
};
