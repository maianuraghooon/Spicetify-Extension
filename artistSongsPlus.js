// NAME: Artist Songs Plus
// AUTHOR: Anurag
// DESCRIPTION: Native-looking track list on artist pages: ALL songs with play counts,
//              sortable, plus total play counts on every album / single in the discography.

(async function artistSongsPlus() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  while (
    !(
      window.Spicetify &&
      Spicetify.Platform &&
      Spicetify.Platform.History &&
      Spicetify.GraphQL &&
      Spicetify.CosmosAsync &&
      Spicetify.Player
    )
  ) {
    await sleep(300);
  }

  // ---------- helpers ----------
  const fmt = new Intl.NumberFormat("en-US");
  const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const idOf = (uri) => String(uri).split(":").pop();
  const fmtDur = (ms) => {
    if (!ms) return "–";
    const s = Math.round(ms / 1000);
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  };
  const debounce = (fn, ms) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };
  async function pool(items, n, fn) {
    let i = 0;
    await Promise.all(
      Array.from({ length: Math.min(n, items.length) }, async () => {
        while (i < items.length) await fn(items[i++]);
      })
    );
  }

  // ---------- state ----------
  const S = {
    artistId: null,
    token: 0,
    albums: new Map(), // albumUri -> {uri,name,type,year,cover,tracks,total,loaded}
    loading: false,
    status: "",
    sort: "plays",
    dir: "desc",
    q: "",
    merge: true,
    tab: "songs",
  };
  const cache = new Map(); // artistId -> {albums}

  // ---------- data fetching ----------
  function pickCover(sources) {
    if (!sources || !sources.length) return "";
    return sources[sources.length - 1].url || sources[0].url || "";
  }

  function walkAlbums(node, out) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((n) => walkAlbums(n, out));
      return;
    }
    if (typeof node.uri === "string" && node.uri.startsWith("spotify:album:") && node.name) {
      if (!out.has(node.uri)) {
        out.set(node.uri, {
          uri: node.uri,
          name: node.name,
          type: node.type || "ALBUM",
          year: node.date?.year || null,
          cover: pickCover(node.coverArt?.sources),
          tracks: [],
          total: 0,
          loaded: false,
        });
      }
      return;
    }
    for (const k in node) walkAlbums(node[k], out);
  }

  async function fetchReleasesGraphQL(artistUri) {
    const defs = Spicetify.GraphQL.Definitions || {};
    const names = defs.queryArtistDiscographyAll
      ? ["queryArtistDiscographyAll"]
      : ["queryArtistDiscographyAlbums", "queryArtistDiscographySingles", "queryArtistDiscographyCompilations"];
    const out = new Map();
    const limit = 50;
    for (const name of names) {
      if (!defs[name]) continue;
      for (let page = 0; page < 40; page++) {
        const res = await Spicetify.GraphQL.Request(defs[name], { uri: artistUri, offset: page * limit, limit });
        const before = out.size;
        walkAlbums(res?.data, out);
        const disc = res?.data?.artistUnion?.discography;
        const total = disc?.all?.totalCount ?? disc?.albums?.totalCount ?? disc?.singles?.totalCount ?? disc?.compilations?.totalCount;
        if (out.size === before) break;
        if (total != null && (page + 1) * limit >= total) break;
      }
    }
    return out;
  }

  async function fetchReleasesWebApi(artistId) {
    const out = new Map();
    for (let offset = 0; offset < 1000; offset += 50) {
      const r = await Spicetify.CosmosAsync.get(
        `https://api.spotify.com/v1/artists/${artistId}/albums?include_groups=album,single,compilation&limit=50&offset=${offset}`
      );
      const items = r?.items || [];
      for (const a of items) {
        out.set(a.uri, {
          uri: a.uri,
          name: a.name,
          type: String(a.album_type || "album").toUpperCase(),
          year: a.release_date ? Number(a.release_date.slice(0, 4)) : null,
          cover: a.images?.length ? a.images[a.images.length - 1].url : "",
          tracks: [],
          total: 0,
          loaded: false,
        });
      }
      if (items.length < 50) break;
    }
    return out;
  }

  async function fetchReleases(artistId) {
    let out = new Map();
    try {
      out = await fetchReleasesGraphQL("spotify:artist:" + artistId);
    } catch (e) {
      console.warn("[ArtistSongsPlus] GraphQL discography failed", e);
    }
    if (!out.size) out = await fetchReleasesWebApi(artistId);
    return out;
  }

  async function fetchAlbum(uri) {
    const res = await Spicetify.GraphQL.Request(Spicetify.GraphQL.Definitions.getAlbum, {
      uri,
      locale: (Spicetify.Locale && Spicetify.Locale.getLocale && Spicetify.Locale.getLocale()) || "en",
      offset: 0,
      limit: 500,
    });
    const au = res?.data?.albumUnion;
    if (!au) throw new Error("no album data");
    const items = au.tracksV2?.items || au.tracks?.items || [];
    const tracks = [];
    for (const it of items) {
      const t = it.track || it;
      if (!t || !t.uri) continue;
      tracks.push({
        uri: t.uri,
        name: t.name,
        plays: Number(t.playcount) || 0,
        dur: t.duration?.totalMilliseconds || 0,
        artistUris: (t.artists?.items || []).map((x) => x.uri).filter(Boolean),
      });
    }
    const total = tracks.reduce((s, t) => s + t.plays, 0);
    const year = au.date?.isoString ? Number(au.date.isoString.slice(0, 4)) : undefined;
    return { tracks, total, year };
  }

  const scheduleRender = debounce(() => renderBody(), 250);

  async function loadArtist(artistId) {
    const my = ++S.token;
    S.artistId = artistId;
    if (cache.has(artistId)) {
      const c = cache.get(artistId);
      S.albums = c.albums;
      S.loading = false;
      S.status = summary();
      renderBody();
      decorate();
      return;
    }
    S.albums = new Map();
    S.loading = true;
    S.status = "Finding releases…";
    renderBody();
    try {
      const rel = await fetchReleases(artistId);
      if (my !== S.token) return;
      S.albums = rel;
      let done = 0;
      await pool([...rel.values()], 4, async (r) => {
        try {
          const a = await fetchAlbum(r.uri);
          if (my !== S.token) return;
          r.tracks = a.tracks;
          r.total = a.total;
          if (a.year) r.year = a.year;
          r.loaded = true;
        } catch (e) {
          r.error = true;
        }
        done++;
        S.status = `Loading releases ${done}/${rel.size}…`;
        scheduleRender();
        decorateSoon();
      });
      if (my !== S.token) return;
      S.loading = false;
      cache.set(artistId, { albums: S.albums });
      S.status = summary();
    } catch (e) {
      console.error("[ArtistSongsPlus]", e);
      S.loading = false;
      S.status = "Error: " + (e && e.message ? e.message : e);
    }
    renderBody();
    decorate();
  }

  // ---------- derived data ----------
  function rawSongs() {
    const list = [];
    for (const a of S.albums.values()) {
      for (const t of a.tracks || []) {
        if (t.artistUris.length && !t.artistUris.includes("spotify:artist:" + S.artistId)) continue;
        list.push({ ...t, album: a.name, albumUri: a.uri, cover: a.cover, year: a.year });
      }
    }
    return list;
  }

  function getSongs(applyFilter = true) {
    let list = rawSongs();
    if (S.merge) {
      const best = new Map();
      for (const s of list) {
        const key = s.name.toLowerCase().trim();
        const cur = best.get(key);
        if (!cur || s.plays > cur.plays) best.set(key, s);
      }
      list = [...best.values()];
    }
    if (applyFilter && S.q) {
      const q = S.q.toLowerCase();
      list = list.filter((s) => s.name.toLowerCase().includes(q) || (s.album || "").toLowerCase().includes(q));
    }
    const d = S.dir === "desc" ? -1 : 1;
    const key = {
      plays: (s) => s.plays,
      year: (s) => Number(s.year) || 0,
      name: (s) => s.name.toLowerCase(),
    }[S.sort];
    list.sort((a, b) => {
      const x = key(a), y = key(b);
      const c = typeof x === "string" ? x.localeCompare(y) : x - y;
      return c * d || b.plays - a.plays;
    });
    return list;
  }

  function getReleases() {
    let list = [...S.albums.values()].filter((a) => a.loaded || !a.error);
    if (S.q) {
      const q = S.q.toLowerCase();
      list = list.filter((a) => a.name.toLowerCase().includes(q));
    }
    const d = S.dir === "desc" ? -1 : 1;
    const key = {
      plays: (a) => a.total,
      year: (a) => Number(a.year) || 0,
      name: (a) => a.name.toLowerCase(),
    }[S.sort];
    list.sort((a, b) => {
      const x = key(a), y = key(b);
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * d;
    });
    return list;
  }

  function summary() {
    const songs = getSongs(false);
    const total = songs.reduce((s, t) => s + t.plays, 0);
    if (songs.length && total === 0) return "Spotify didn't return play counts for this artist.";
    return `${songs.length} songs · ${S.albums.size} releases · ${compact.format(total)} total plays`;
  }

  // ---------- UI (styled to match Spotify's own track lists) ----------
  const css = `
  #asp-panel{margin:24px 32px 32px;color:var(--spice-text,#fff);font-size:14px}
  #asp-panel .asp-title{font-size:24px;font-weight:700;letter-spacing:-.04em;margin:0}
  #asp-panel .asp-status{font-size:13px;font-weight:400;letter-spacing:normal;color:var(--spice-subtext,#b3b3b3);margin-left:12px}
  #asp-panel .asp-controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:16px 0 8px}
  #asp-panel .asp-spacer{flex:1}
  #asp-panel .asp-chip,#asp-panel select,#asp-panel input[type=text]{background:rgba(255,255,255,.07);color:var(--spice-text,#fff);border:0;border-radius:16px;padding:6px 12px;font-size:13px;font-family:inherit}
  #asp-panel .asp-chip{cursor:pointer}
  #asp-panel .asp-chip:hover,#asp-panel select:hover{background:rgba(255,255,255,.14)}
  #asp-panel .asp-chip.asp-active{background:var(--spice-text,#fff);color:var(--spice-main,#121212)}
  #asp-panel select{cursor:pointer}
  #asp-panel select option{background:var(--spice-main,#121212);color:var(--spice-text,#fff)}
  #asp-panel input[type=text]{min-width:150px;outline:none}
  #asp-panel input[type=text]:focus{background:rgba(255,255,255,.14)}
  #asp-panel label{display:flex;align-items:center;gap:6px;color:var(--spice-subtext,#b3b3b3);font-size:13px;cursor:pointer}
  #asp-panel .asp-hrow,#asp-panel .asp-row{display:grid;grid-template-columns:32px minmax(200px,6fr) 60px minmax(120px,2fr) 70px;column-gap:16px;align-items:center;padding:0 16px}
  #asp-panel .asp-disc{grid-template-columns:32px minmax(200px,6fr) 60px minmax(120px,2fr)}
  #asp-panel .asp-hrow{height:36px;color:var(--spice-subtext,#b3b3b3);font-size:12px;letter-spacing:.1em;text-transform:uppercase;border-bottom:1px solid rgba(255,255,255,.1);margin-bottom:8px}
  #asp-panel .asp-hrow [data-sort]{cursor:pointer}
  #asp-panel .asp-hrow [data-sort]:hover{color:var(--spice-text,#fff)}
  #asp-panel .asp-row{height:56px;border-radius:4px;cursor:pointer}
  #asp-panel .asp-row:hover{background:rgba(255,255,255,.1)}
  #asp-panel .asp-r{text-align:right;font-variant-numeric:tabular-nums}
  #asp-panel .asp-idx{color:var(--spice-subtext,#b3b3b3);text-align:right;font-variant-numeric:tabular-nums}
  #asp-panel .asp-cell-title{display:flex;align-items:center;gap:12px;min-width:0}
  #asp-panel .asp-cell-title img,#asp-panel .asp-cell-title .asp-noimg{width:40px;height:40px;border-radius:4px;flex:none;background:rgba(255,255,255,.1)}
  #asp-panel .asp-text{min-width:0}
  #asp-panel .asp-name{font-size:16px;color:var(--spice-text,#fff);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #asp-panel .asp-sub{font-size:13px;color:var(--spice-subtext,#b3b3b3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #asp-panel .asp-row:hover .asp-sub{color:var(--spice-text,#fff)}
  #asp-panel .asp-muted{color:var(--spice-subtext,#b3b3b3);font-size:14px}
  #asp-panel .asp-row.asp-playing .asp-name,#asp-panel .asp-row.asp-playing .asp-idx{color:var(--spice-button,#1db954)}
  #asp-panel .asp-empty{padding:24px 16px;color:var(--spice-subtext,#b3b3b3)}
  .asp-badge{margin-top:4px;font-size:12px;font-weight:600;color:var(--spice-subtext,#b3b3b3)}
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  // Play the clicked song, then line up every song after it (in the order currently shown) in the queue.
  let playToken = 0;
  async function playFrom(uri) {
    const list = getSongs();
    const i = list.findIndex((s) => s.uri === uri);
    if (i < 0) return Spicetify.Player.playUri(uri);
    const my = ++playToken;
    await Spicetify.Player.playUri(uri);
    try {
      await Spicetify.Platform.PlayerAPI.clearQueue();
      const rest = list.slice(i + 1).map((s) => ({ uri: s.uri }));
      for (let k = 0; k < rest.length; k += 50) {
        if (my !== playToken) return; // you clicked another song meanwhile
        await Spicetify.addToQueue(rest.slice(k, k + 50));
      }
    } catch (e) {
      console.warn("[ArtistSongsPlus] couldn't fill the queue", e);
      Spicetify.showNotification("Couldn't queue the rest of the list", true);
    }
  }

  function buildPanel() {
    const p = document.createElement("div");
    p.id = "asp-panel";
    p.innerHTML = `
      <h2 class="asp-title">All songs <span class="asp-status"></span></h2>
      <div class="asp-controls">
        <button class="asp-chip" data-tab="songs">Songs</button>
        <button class="asp-chip" data-tab="disc">Discography</button>
        <span class="asp-spacer"></span>
        <input type="text" class="asp-search" placeholder="Filter…" />
        <label class="asp-merge-wrap"><input type="checkbox" class="asp-merge" checked /> Merge duplicates</label>
        <select class="asp-sort">
          <option value="plays">Play count</option>
          <option value="year">Release year</option>
          <option value="name">Name</option>
        </select>
        <button class="asp-chip asp-queue">Queue top 50</button>
      </div>
      <div class="asp-body"></div>`;

    p.querySelectorAll("[data-tab]").forEach((b) => {
      b.onclick = () => {
        S.tab = b.dataset.tab;
        renderBody();
      };
    });
    p.querySelector(".asp-sort").onchange = (e) => {
      S.sort = e.target.value;
      S.dir = S.sort === "name" ? "asc" : "desc";
      renderBody();
    };
    p.querySelector(".asp-search").oninput = debounce((e) => {
      S.q = e.target.value;
      renderBody();
    }, 200);
    p.querySelector(".asp-merge").onchange = (e) => {
      S.merge = e.target.checked;
      if (!S.loading) S.status = summary();
      renderBody();
    };
    p.querySelector(".asp-queue").onclick = () => {
      const uris = getSongs().slice(0, 50).map((s) => ({ uri: s.uri }));
      if (!uris.length) return;
      try {
        Spicetify.addToQueue(uris);
        Spicetify.showNotification(`Added ${uris.length} songs to queue`);
      } catch (e) {
        Spicetify.showNotification("Couldn't add to queue", true);
      }
    };
    p.querySelector(".asp-body").onclick = (e) => {
      const h = e.target.closest("[data-sort]");
      if (h) {
        const k = h.dataset.sort;
        if (S.sort === k) S.dir = S.dir === "desc" ? "asc" : "desc";
        else {
          S.sort = k;
          S.dir = k === "name" ? "asc" : "desc";
        }
        return renderBody();
      }
      const rowSong = e.target.closest(".asp-row[data-uri]");
      if (rowSong) return playFrom(rowSong.dataset.uri);
      const rowAlbum = e.target.closest(".asp-row[data-album]");
      if (rowAlbum) Spicetify.Platform.History.push("/album/" + rowAlbum.dataset.album);
    };
    return p;
  }

  const arrow = (k) => (S.sort === k ? (S.dir === "desc" ? " ↓" : " ↑") : "");

  function songsHtml() {
    const list = getSongs();
    if (!list.length) return `<div class="asp-empty">${S.loading ? "Loading…" : "No songs found."}</div>`;
    const head = `<div class="asp-hrow">
        <span class="asp-r">#</span>
        <span data-sort="name">Title${arrow("name")}</span>
        <span data-sort="year">Year${arrow("year")}</span>
        <span class="asp-r" data-sort="plays">Plays${arrow("plays")}</span>
        <span class="asp-r">Time</span></div>`;
    const rows = list
      .map(
        (s, i) => `<div class="asp-row" data-uri="${esc(s.uri)}">
          <span class="asp-idx">${i + 1}</span>
          <div class="asp-cell-title">${s.cover ? `<img src="${esc(s.cover)}" />` : '<div class="asp-noimg"></div>'}
            <div class="asp-text"><div class="asp-name">${esc(s.name)}</div><div class="asp-sub">${esc(s.album)}</div></div></div>
          <span class="asp-muted">${esc(s.year || "")}</span>
          <span class="asp-r asp-muted">${s.plays ? fmt.format(s.plays) : "–"}</span>
          <span class="asp-r asp-muted">${fmtDur(s.dur)}</span></div>`
      )
      .join("");
    return head + rows;
  }

  function discHtml() {
    const list = getReleases();
    if (!list.length) return `<div class="asp-empty">${S.loading ? "Loading…" : "No releases found."}</div>`;
    const head = `<div class="asp-hrow asp-disc">
        <span class="asp-r">#</span>
        <span data-sort="name">Release${arrow("name")}</span>
        <span data-sort="year">Year${arrow("year")}</span>
        <span class="asp-r" data-sort="plays">Total plays${arrow("plays")}</span></div>`;
    const rows = list
      .map((a, i) => {
        const type = String(a.type).charAt(0) + String(a.type).slice(1).toLowerCase();
        const n = a.tracks.length ? ` · ${a.tracks.length} tracks` : "";
        return `<div class="asp-row asp-disc" data-album="${esc(idOf(a.uri))}">
          <span class="asp-idx">${i + 1}</span>
          <div class="asp-cell-title">${a.cover ? `<img src="${esc(a.cover)}" />` : '<div class="asp-noimg"></div>'}
            <div class="asp-text"><div class="asp-name">${esc(a.name)}</div><div class="asp-sub">${esc(type + n)}</div></div></div>
          <span class="asp-muted">${esc(a.year || "")}</span>
          <span class="asp-r asp-muted">${a.loaded ? fmt.format(a.total) : a.error ? "n/a" : "…"}</span></div>`;
      })
      .join("");
    return head + rows;
  }

  function highlightPlaying() {
    const uri = Spicetify.Player.data?.item?.uri || Spicetify.Player.data?.track?.uri;
    document.querySelectorAll("#asp-panel .asp-row[data-uri]").forEach((r) => {
      r.classList.toggle("asp-playing", !!uri && r.dataset.uri === uri);
    });
  }

  function renderBody() {
    const p = document.getElementById("asp-panel");
    if (!p) return;
    p.querySelector(".asp-status").textContent = S.status;
    p.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("asp-active", b.dataset.tab === S.tab));
    p.querySelector(".asp-merge-wrap").style.display = S.tab === "songs" ? "" : "none";
    p.querySelector(".asp-queue").style.display = S.tab === "songs" ? "" : "none";
    p.querySelector(".asp-sort").value = S.sort;
    p.querySelector(".asp-body").innerHTML = S.tab === "songs" ? songsHtml() : discHtml();
    highlightPlaying();
  }

  function currentArtistId() {
    const m = (Spicetify.Platform.History.location?.pathname || "").match(/^\/artist\/([A-Za-z0-9]+)/);
    return m ? m[1] : null;
  }

  function placePanel() {
    if (!currentArtistId()) return;
    let panel = document.getElementById("asp-panel");
    const bar = document.querySelector('[data-testid="action-bar-row"]');
    const host = bar ? bar.parentElement : document.querySelector(".main-view-container__scroll-node-child");
    if (!host) return;
    if (!panel) {
      panel = buildPanel();
      bar ? bar.insertAdjacentElement("afterend", panel) : host.prepend(panel);
      renderBody();
      return;
    }
    if (bar ? panel.previousElementSibling !== bar : panel.parentElement !== host) {
      bar ? bar.insertAdjacentElement("afterend", panel) : host.prepend(panel);
    }
  }

  // ---------- play counts on discography cards ----------
  function decorate() {
    if (!S.artistId || !currentArtistId()) return;
    document.querySelectorAll('a[href^="/album/"]').forEach((a) => {
      if (a.closest("#asp-panel")) return;
      const id = (a.getAttribute("href").split("/")[2] || "").split("?")[0];
      const alb = S.albums.get("spotify:album:" + id);
      if (!alb || !alb.loaded) return;
      const card = a.closest('[data-encore-id="card"], .main-card-card, [data-testid="card"]');
      if (!card) return;
      const text = `${compact.format(alb.total)} plays`;
      let b = card.querySelector(".asp-badge");
      if (!b) {
        b = document.createElement("div");
        b.className = "asp-badge";
        card.appendChild(b);
      }
      if (b.textContent !== text) b.textContent = text;
    });
  }
  const decorateSoon = debounce(decorate, 500);

  // ---------- wiring ----------
  function onRoute() {
    const id = currentArtistId();
    if (!id) {
      const p = document.getElementById("asp-panel");
      if (p) p.remove();
      return;
    }
    if (id !== S.artistId) loadArtist(id);
    placePanel();
  }

  Spicetify.Platform.History.listen(() => setTimeout(onRoute, 250));
  Spicetify.Player.addEventListener("songchange", highlightPlaying);
  new MutationObserver(
    debounce(() => {
      if (currentArtistId()) {
        placePanel();
        decorate();
      }
    }, 400)
  ).observe(document.body, { childList: true, subtree: true });
  onRoute();
})();
