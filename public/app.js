// jetstream client - hash-routed youtube frontend riding ramjet's session.
// per-user data (history, resume, settings, subscriptions) syncs through
// ramjet's encrypted sync blob under the "jetstream" key, localStorage
// fallback when sync is locked or off.
const view = document.getElementById("view");
const qInput = document.getElementById("q");
const LS_KEY = "jetstream-store";
const DEFAULT_SETTINGS = { autoplayNext: true, resume: true, quality: "auto", algo: true, clearOnExit: false };

// -- theme: follow ramjet's own theme -----------------------------------------
// ramjet persists appearance settings same-origin under "rj.settings"; when its
// encrypted sync pulls settings on another device it writes the same key, so
// jetstream just mirrors it. lowData there also gates our prefetch warming.
const RJ_THEMES = { amber: ["#ffa028", "#c96f04"], mint: ["#34d399", "#059669"], sky: ["#38bdf8", "#0369a1"], violet: ["#a78bfa", "#6d28d9"], ember: ["#f87171", "#b91c1c"] };
let rjLowData = false;
function rjShade(hex, amt) {
	const n = parseInt(hex.slice(1), 16);
	const ch = (v) => Math.max(0, Math.min(255, Math.round(v * (1 + amt))));
	return "#" + [ch(n >> 16), ch((n >> 8) & 255), ch(n & 255)].map((v) => v.toString(16).padStart(2, "0")).join("");
}
function applyRamjetTheme() {
	let s = null;
	try { s = JSON.parse(localStorage.getItem("rj.settings") || "null"); } catch (e) {}
	let pair = RJ_THEMES.amber;
	if (s && typeof s === "object") {
		rjLowData = !!s.lowData;
		if (s.theme === "custom") {
			const a = /^#[0-9a-fA-F]{6}$/.test(s.customAccent || "") ? s.customAccent : "#ffa028";
			pair = [a, rjShade(a, -0.35)];
		} else if (RJ_THEMES[s.theme]) pair = RJ_THEMES[s.theme];
	}
	document.documentElement.style.setProperty("--amber", pair[0]);
	document.documentElement.style.setProperty("--amber-deep", pair[1]);
}
applyRamjetTheme();

let store = { history: [], progress: {}, settings: { ...DEFAULT_SETTINGS }, subs: [], later: [] };
let saveQueued = false;
// play-all queue (channel pages, playlists) - lives only in this page session
let queue = null; // { label, items: [{id,title,...}], }

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

async function api(path) {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const r = await fetch("/api/jetstream/" + path);
			if (r.status === 401) { location.href = "/login"; throw new Error("locked"); }
			if (!r.ok) throw new Error("api " + r.status);
			return await r.json();
		} catch (e) {
			if (e.message === "locked" || attempt === 1) throw e;
			await new Promise((res) => setTimeout(res, 1200));
		}
	}
}

// -- speed: warm the server cache before he taps ------------------------------
function idle(fn) {
	if ("requestIdleCallback" in window) requestIdleCallback(fn, { timeout: 4000 });
	else setTimeout(fn, 1600);
}
function prefetch(path) { if (rjLowData) return; fetch("/api/jetstream/" + path).catch(() => {}); }

// -- per-user store -----------------------------------------------------------
function norm(s) {
	if (!s || typeof s !== "object") return;
	store = {
		history: s.history || [],
		progress: s.progress || {},
		settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) },
		subs: Array.isArray(s.subs) ? s.subs : [],
		later: Array.isArray(s.later) ? s.later : [],
	};
}
function loadLocal() {
	try { norm(JSON.parse(localStorage.getItem(LS_KEY) || "null")); } catch (e) {}
}
async function loadRemote() {
	if (typeof RJCrypto === "undefined") return;
	try {
		if (!RJCrypto.unlocked()) await RJCrypto.tryRestore();
		if (!RJCrypto.unlocked()) return;
		const blob = await RJCrypto.pull();
		if (blob && blob.jetstream) {
			norm(blob.jetstream);
			try { localStorage.setItem(LS_KEY, JSON.stringify(store)); } catch (e) {}
		}
	} catch (e) {}
}
function save() {
	try { localStorage.setItem(LS_KEY, JSON.stringify(store)); } catch (e) {}
	if (saveQueued) return;
	saveQueued = true;
	setTimeout(async () => {
		saveQueued = false;
		if (typeof RJCrypto === "undefined" || !RJCrypto.unlocked()) return;
		try {
			const blob = (await RJCrypto.pull()) || {};
			blob.jetstream = { history: store.history.slice(0, 40), progress: store.progress, settings: store.settings, subs: store.subs, later: store.later.slice(0, 60) };
			await RJCrypto.push(blob);
		} catch (e) {}
	}, 1200);
}
function durToSec(d) {
	const m = /^(\d+):(\d\d)$/.exec(d || "");
	return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}
function pushHistory(it) {
	store.history = store.history.filter((h) => h.id !== it.id);
	store.history.unshift({ id: it.id, title: it.title, uploader: it.uploader, thumb: it.thumb, dur: it.dur, durSec: durToSec(it.dur), at: Date.now() });
	store.history = store.history.slice(0, 40);
	save();
}
function setProgress(id, seconds) {
	if (!id || !isFinite(seconds) || seconds < 5) return;
	store.progress[id] = Math.floor(seconds);
	save();
}
function isSubbed(name) { return store.subs.some((s) => s.name.toLowerCase() === String(name || "").toLowerCase()); }
function toggleSub(name, chId) {
	if (isSubbed(name)) store.subs = store.subs.filter((s) => s.name.toLowerCase() !== name.toLowerCase());
	else store.subs.unshift({ name, chId: chId || "", at: Date.now() });
	save();
}

function isLater(id) { return store.later.some((x) => x.id === id); }
function toggleLater(v) {
	if (isLater(v.id)) store.later = store.later.filter((x) => x.id !== v.id);
	else store.later.unshift({ id: v.id, title: v.title, uploader: v.uploader || "", thumb: v.thumb || "", dur: v.dur || "", at: Date.now() });
	save();
}

// -- queue ----------------------------------------------------------------------
function startQueue(label, items) {
	if (!items || !items.length) return;
	queue = { label, items };
	location.hash = "#/w/" + items[0].id;
}
function queueNext(id) {
	if (!queue) return null;
	const i = queue.items.findIndex((x) => x.id === id);
	if (i < 0 || i + 1 >= queue.items.length) return null;
	return queue.items[i + 1];
}

// -- for-you ranking ----------------------------------------------------------
// jetstream's own algorithm: score listings by the per-user signal already in
// the synced blob (subs + watch history). off in settings = plain order.
function rankItems(items) {
	const subbed = new Set(store.subs.map((s) => s.name.toLowerCase()));
	const histU = new Map();
	const seen = new Set();
	for (const h of store.history) {
		const u = (h.uploader || "").toLowerCase();
		if (u) histU.set(u, (histU.get(u) || 0) + 1);
		seen.add(h.id);
	}
	return items.map((it, i) => {
		const u = (it.uploader || "").toLowerCase();
		let score = 0;
		if (subbed.has(u)) score += 6;                    // channels he chose
		score += Math.min(4, histU.get(u) || 0);          // channels he keeps watching
		if (seen.has(it.id)) score -= 8;                  // already watched sinks
		return [score, i, it];
	}).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map((x) => x[2]);
}

// -- rendering ----------------------------------------------------------------
function compact(n) {
	n = Number(n) || 0;
	if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
	if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
	if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
	return "" + n;
}
function fmtViews(v) {
	return compact(v) + " views";
}
function fmtLikes(x) {
	const n = Number(String(x).replace(/[^\d]/g, ""));
	if (!isFinite(n) || n < 10000) return x;
	return compact(n);
}
function card(it) {
	const meta = it.metaText || [it.uploader, it.views ? fmtViews(it.views) : "", it.resume || ""].filter(Boolean).join(" · ");
	const pct = it.progressPct ? `<div class="watched"><div style="width:${Math.min(100, it.progressPct)}%"></div></div>` : "";
	const badge = it.short ? '<span class="dur">short</span>' : it.live ? '<span class="dur live">live</span>' : it.dur ? `<span class="dur">${esc(it.dur)}</span>` : "";
	return `<a class="card" href="#/w/${esc(it.id)}">
		<div class="thumbwrap"><img loading="lazy" src="${esc(it.thumb)}" alt="">${pct}${badge}</div>
		<p class="ctitle">${esc(it.title)}</p>
		<p class="cmeta">${esc(meta)}</p>
	</a>`;
}
function grid(items) {
	if (!items.length) return '<p class="dim pad">nothing here.</p>';
	return '<div class="grid">' + items.map(card).join("") + "</div>";
}
function shortCard(it) {
	return `<a class="shortcard" href="#/w/${esc(it.id)}">
		<div class="shortthumb"><img loading="lazy" src="${esc(it.thumb)}" alt=""><span class="dur">short</span></div>
		<p class="ctitle">${esc(it.title)}</p>
	</a>`;
}
function skeleton() {
	let s = '<div class="grid">';
	for (let i = 0; i < 8; i++) s += '<div class="skel"><div class="skel-thumb"></div><div class="skel-line"></div><div class="skel-line short"></div></div>';
	return s + "</div>";
}
function setTab(name) {
	for (const a of document.querySelectorAll(".tabs a")) a.classList.toggle("on", a.dataset.tab === name);
}
function errBox(msg) {
	view.innerHTML = `<div class="note"><p>${esc(msg)}</p><button class="plain" onclick="route()">retry</button></div>`;
}

// -- for you ----------------------------------------------------------------------
// his own feed: latest from his channels + related to recent watches, deduped,
// watched videos sunk, ranked by his signal (subs + history). the default tab.
let foryouCache = null;
async function foryouPool() {
	if (foryouCache) return foryouCache;
	const pool = [];
	const seen = new Set();
	const add = (items) => { for (const it of items || []) { if (it && it.id && !seen.has(it.id)) { seen.add(it.id); pool.push(it); } } };
	const names = store.subs.slice(0, 8).map((x) => x.name);
	if (names.length) {
		const results = await Promise.all(names.map((n) => api("search?q=" + encodeURIComponent(n)).catch(() => ({ items: [] }))));
		results.forEach((d, i) => {
			const want = names[i].toLowerCase();
			let took = 0;
			for (const it of d.items || []) {
				if ((it.uploader || "").toLowerCase() !== want) continue;
				add([it]);
				if (++took >= 3) break;
			}
		});
	}
	// "because you watched": related of his last two watches (usually warm from prefetch)
	for (const h of store.history.slice(0, 2)) {
		try { const w = await api("watch?v=" + encodeURIComponent(h.id)); add((w.related || []).slice(0, 6)); } catch (e) {}
	}
	foryouCache = pool;
	return pool;
}
async function showForYou() {
	setTab("foryou");
	view.innerHTML = skeleton();
	const watched = new Set(store.history.map((h) => h.id));
	const pool = (await foryouPool()).filter((it) => !watched.has(it.id));
	if (!pool.length) {
		view.innerHTML = store.subs.length
			? '<div class="note"><p>your feed is warming up.</p><p class="dim" style="margin:0">the upstream is busy right now - try again in a bit.</p></div>'
			: '<div class="note"><p>your feed builds itself.</p><p class="dim" style="margin:0">subscribe to channels and watch a few things - this page becomes videos picked for you.</p></div>';
		return;
	}
	const items = store.settings.algo ? rankItems(pool) : pool;
	view.innerHTML = grid(items) + '<div id="fymore"></div>';
	idle(() => items.slice(0, 3).forEach((it, i) => setTimeout(() => prefetch("watch?v=" + it.id), i * 900)));
	// endless feed: as he nears the bottom, fold in related of his next watches
	// (deduped, watched sunk) so the feed never runs dry
	const fyEl = document.getElementById("fymore");
	const gridEl = view.querySelector(".grid");
	if (fyEl && gridEl) {
		let expanding = 0, busy = false;
		const have = new Set(items.map((x) => x.id));
		const fyObs = new IntersectionObserver(async (ents) => {
			if (busy || expanding >= 12 || !ents.some((x) => x.isIntersecting)) return;
			const nextHist = store.history.slice(2 + expanding);
			if (!nextHist.length) { fyObs.disconnect(); return; }
			busy = true; expanding++;
			try {
				const fresh = [];
				for (const h of nextHist.slice(0, 2)) {
					try { const w = await api("watch?v=" + encodeURIComponent(h.id)); fresh.push(...(w.related || [])); } catch (e) {}
				}
				const add = fresh.filter((it) => it && it.id && !watched.has(it.id) && !have.has(it.id));
				add.forEach((it) => have.add(it.id));
				if (add.length) {
					const ranked = store.settings.algo ? rankItems(add) : add;
					gridEl.insertAdjacentHTML("beforeend", ranked.map(card).join(""));
				}
			} catch (e) {}
			busy = false;
			if (expanding >= 12) fyObs.disconnect();
		}, { rootMargin: "900px" });
		fyObs.observe(fyEl);
	}
}

async function showTrending() {
	setTab("home");
	view.innerHTML = skeleton();
	try {
		const d = await api("trending");
		let items = store.settings.algo ? rankItems(d.items || []) : (d.items || []);
		if (items.length >= 8) {
			view.innerHTML = grid(items);
			const top = items.slice(0, 3);
			if (top.length) idle(() => top.forEach((it, i) => setTimeout(() => prefetch("watch?v=" + it.id), i * 900)));
			return;
		}
		// live-heavy night: lives stay hidden, so top up from his own feed - the page is never empty
		const watched = new Set(store.history.map((h) => h.id));
		const have = new Set(items.map((x) => x.id));
		const pool = (await foryouPool()).filter((it) => !watched.has(it.id) && !have.has(it.id));
		const extra = (store.settings.algo ? rankItems(pool) : pool).slice(0, 16);
		if (!items.length && !extra.length) {
			view.innerHTML = '<div class="note"><p>trending is all live right now and lives can\'t play here yet.</p><p class="dim" style="margin:0">search works meanwhile - or subscribe to a channel and your for-you tab takes over.</p></div>';
			return;
		}
		view.innerHTML = (items.length ? grid(items) : '<p class="dim pad" style="padding-bottom:0">trending is wall-to-wall live right now - lives stay hidden since they can\'t play here.</p>')
			+ (extra.length ? '<h2 class="sec pad">meanwhile, for you</h2>' + grid(extra) : "");
	} catch (e) { errBox("trending won't load right now - the upstream is probably rate-limited."); }
}

async function showSearch(q) {
	setTab("");
	qInput.value = q;
	view.innerHTML = `<h2 class="sec pad" style="padding-bottom:0">results for "${esc(q)}"</h2>
	<div class="fchips pad" style="padding-top:8px;padding-bottom:0" id="fchips">
		<button class="fchip on" data-f="videos">videos</button><button class="fchip" data-f="shorts">shorts</button><button class="fchip" data-f="channels">channels</button><button class="fchip" data-f="playlists">playlists</button>
	</div><div id="sresults">` + skeleton() + "</div>";
	const resultsEl = document.getElementById("sresults");
	let observer = null;
	const stopLoad = () => { if (observer) { observer.disconnect(); observer = null; } };

	// videos: innertube's own ranked order (youtube parity - no re-ranking here),
	// lazy loads more as you scroll via continuation tokens.
	async function loadVideos() {
		resultsEl.innerHTML = skeleton();
		try {
			const d = await api("search?q=" + encodeURIComponent(q));
			const items = d.items || [];
			if (!items.length) { resultsEl.innerHTML = '<p class="dim pad">no videos matched that.</p>'; return; }
			resultsEl.innerHTML = '<div class="grid" id="sgrid">' + items.map(card).join("") + '</div><div id="smore"></div>';
			let cont = d.continuation || "";
			const more = document.getElementById("smore");
			const gridEl = document.getElementById("sgrid");
			if (!cont || !more) return;
			let busy = false;
			observer = new IntersectionObserver(async (ents) => {
				if (busy || !cont || !ents.some((x) => x.isIntersecting)) return;
				busy = true;
				try {
					const d2 = await api("search?q=" + encodeURIComponent(q) + "&cont=" + encodeURIComponent(cont));
					cont = d2.continuation || "";
					if (d2.items && d2.items.length) gridEl.insertAdjacentHTML("beforeend", d2.items.map(card).join(""));
				} catch (e) {}
				busy = false;
				if (!cont) stopLoad();
			}, { rootMargin: "900px" });
			observer.observe(more);
		} catch (e) { resultsEl.innerHTML = '<p class="dim pad">that search failed - try again.</p>'; }
	}
	async function loadShorts() {
		resultsEl.innerHTML = skeleton();
		try {
			const d = await api("search?q=" + encodeURIComponent(q) + "&filter=shorts");
			const items = d.items || [];
			resultsEl.innerHTML = items.length ? '<div class="sgrid">' + items.map(shortCard).join("") + "</div>" : '<p class="dim pad">no shorts matched that.</p>';
		} catch (e) { resultsEl.innerHTML = '<p class="dim pad">that search failed - try again.</p>'; }
	}
	async function loadChannels() {
		resultsEl.innerHTML = skeleton();
		try {
			const d = await api("search-channels?q=" + encodeURIComponent(q));
			const cs = (d && d.items) || [];
			resultsEl.innerHTML = cs.length
				? '<div class="plrow">' + cs.map((c) => `<a class="plcard" href="#/c/${esc(c.id)}">
					${c.avatar ? `<img loading="lazy" src="${esc(c.avatar)}" alt="" style="border-radius:50%">` : ""}
					<span class="plinfo"><b>${esc(c.name)}</b><span class="dim">${c.subs > 0 ? fmtViews(c.subs).replace("views", "subscribers") : "channel"}${c.description ? " · " + esc(c.description) : ""}</span></span>
				</a>`).join("") + "</div>"
				: '<p class="dim pad">no channels matched that.</p>';
		} catch (e) { resultsEl.innerHTML = '<p class="dim pad">that search failed - try again.</p>'; }
	}
	async function loadPlaylists() {
		resultsEl.innerHTML = skeleton();
		try {
			const p = await api("search-playlists?q=" + encodeURIComponent(q));
			const pls = (p && p.items) || [];
			resultsEl.innerHTML = pls.length
				? '<div class="plrow">' + pls.map((pl) => `<a class="plcard" href="#/p/${esc(pl.id)}">
					${pl.thumb ? `<img loading="lazy" src="${esc(pl.thumb)}" alt="">` : ""}
					<span class="plinfo"><b>${esc(pl.title)}</b><span class="dim">playlist${pl.count ? " · " + pl.count + " videos" : ""}${pl.uploader ? " · " + esc(pl.uploader) : ""}</span></span>
				</a>`).join("") + "</div>"
				: '<p class="dim pad">no playlists matched that.</p>';
		} catch (e) { resultsEl.innerHTML = '<p class="dim pad">that search failed - try again.</p>'; }
	}
	const loaders = { videos: loadVideos, shorts: loadShorts, channels: loadChannels, playlists: loadPlaylists };
	for (const b of document.querySelectorAll(".fchip")) {
		b.addEventListener("click", () => {
			if (b.classList.contains("on")) return;
			stopLoad();
			for (const x of document.querySelectorAll(".fchip")) x.classList.remove("on");
			b.classList.add("on");
			(loaders[b.dataset.f] || loadVideos)();
		});
	}
	loadVideos();
}

async function showChannel(id) {
	setTab("");
	view.innerHTML = skeleton();
	let d;
	try { d = await api("channel?id=" + encodeURIComponent(id)); }
	catch (e) { return errBox("couldn't load that channel."); }
	const subbed = isSubbed(d.name);
	const vids = d.videos || [];
	const shorts = d.shorts || [];
	const pls = d.playlists || [];
	view.innerHTML = `<div class="chhead">
		${d.avatar ? `<img class="chavatar" src="${esc(d.avatar)}" alt="">` : ""}
		<div class="chinfo">
			<p class="chname">${esc(d.name)}</p>
			${d.subs ? `<p class="dim" style="margin:2px 0 0">${esc(d.subs)}</p>` : ""}
			${!d.subs && d.vidCount ? `<p class="dim" style="margin:2px 0 0">${esc(d.vidCount)} videos</p>` : ""}
		</div>
		<button class="plain subbtn${subbed ? " on" : ""}" id="subbtn">${subbed ? "subscribed" : "subscribe"}</button>
	</div>
	${vids.length ? `<div class="pad" style="padding-top:0"><button class="plain" id="playall">play all</button></div>` : ""}
	${d.description ? `<details class="desc pad" style="padding-top:0"><summary>about</summary><pre>${esc(d.description)}</pre></details>` : ""}
	${shorts.length ? `<h2 class="sec">shorts</h2><div class="shortrow">${shorts.map(shortCard).join("")}</div>` : ""}
	${pls.length ? `<h2 class="sec">playlists</h2><div class="plrow">${pls.map((pl) => `<a class="plcard" href="#/p/${esc(pl.id)}">
		${pl.thumb ? `<img loading="lazy" src="${esc(pl.thumb)}" alt="">` : ""}
		<span class="plinfo"><b>${esc(pl.title)}</b><span class="dim">playlist</span></span>
	</a>`).join("")}</div>` : ""}
	${vids.length ? '<h2 class="sec">videos</h2>' + grid(vids) + '<div id="chmore"></div>' : ""}
	${!vids.length && !shorts.length ? '<p class="dim pad">no videos found on this channel.</p>' : ""}`;
	// endless channel videos: keeps paging through the catalog as you scroll
	const chMore = document.getElementById("chmore");
	const chGrid = chMore && chMore.previousElementSibling;
	if (chMore && chGrid && d.continuation) {
		let cont = d.continuation, busy = false;
		const have = new Set(vids.map((x) => x.id));
		const chObs = new IntersectionObserver(async (ents) => {
			if (busy || !cont || !ents.some((x) => x.isIntersecting)) return;
			busy = true;
			try {
				const d2 = await api("channel?id=" + encodeURIComponent(id) + "&cont=" + encodeURIComponent(cont));
				cont = d2.continuation || "";
				const fresh = (d2.videos || []).filter((it) => it && it.id && !have.has(it.id));
				fresh.forEach((it) => have.add(it.id));
				if (fresh.length) chGrid.insertAdjacentHTML("beforeend", fresh.map(card).join(""));
			} catch (e) {}
			busy = false;
			if (!cont) chObs.disconnect();
		}, { rootMargin: "900px" });
		chObs.observe(chMore);
	}
	document.getElementById("subbtn").addEventListener("click", () => {
		toggleSub(d.name, d.id || "");
		const b = document.getElementById("subbtn");
		const on = isSubbed(d.name);
		b.textContent = on ? "subscribed" : "subscribe";
		b.classList.toggle("on", on);
	});
	const pa = document.getElementById("playall");
	if (pa) pa.addEventListener("click", () => startQueue(d.name, vids));
	if (vids.length) idle(() => setTimeout(() => prefetch("watch?v=" + vids[0].id), 600));
}

async function showPlaylist(id) {
	setTab("");
	view.innerHTML = skeleton();
	let d;
	try { d = await api("playlist?id=" + encodeURIComponent(id)); }
	catch (e) { return errBox("couldn't load that playlist."); }
	const vids = d.videos || [];
	view.innerHTML = `<div class="pad">
		<h2 class="sec" style="padding:0 0 6px">${esc(d.title)}</h2>
		<p class="dim" style="margin:0 0 10px">playlist · ${vids.length} videos</p>
		${vids.length ? `<button class="plain" id="playall">play all</button>` : ""}
	</div>` + (vids.length
		? '<div class="pllist">' + vids.map((it, i) => `<a class="plitem" href="#/w/${esc(it.id)}">
			<span class="plnum">${i + 1}</span>
			<img loading="lazy" src="${esc(it.thumb)}" alt="">
			<span class="pliteminfo"><b>${esc(it.title)}</b><span class="dim">${esc(it.metaText || it.dur || "")}</span></span>
		</a>`).join("") + "</div>"
		: '<p class="dim pad">this playlist looks empty.</p>');
	const pa = document.getElementById("playall");
	if (pa) pa.addEventListener("click", () => startQueue(d.title, vids));
	if (vids.length) idle(() => setTimeout(() => prefetch("watch?v=" + vids[0].id), 600));
}

// -- comments -------------------------------------------------------------------
const commentsCache = {};
function fetchComments(id) {
	if (!commentsCache[id]) commentsCache[id] = api("comments?v=" + encodeURIComponent(id)).catch(() => null);
	return commentsCache[id];
}
function commentRow(c) {
	return `<div class="cmt">
		${c.avatar ? `<img class="cmtavatar" loading="lazy" src="${esc(c.avatar)}" alt="">` : '<span class="cmtavatar"></span>'}
		<div class="cmtbody">
			<p class="cmtmeta"><b>${esc(c.author)}</b>${c.pinned ? '<span class="cmtpin">pinned</span>' : ""} <span class="dim">${esc([c.time, c.likes].filter(Boolean).join(" · "))}</span></p>
			<p class="cmttext">${esc(c.text)}</p>
		</div>
	</div>`;
}
async function fillComments(id) {
	const box = document.getElementById("cmts");
	if (!box) return;
	const d = await fetchComments(id);
	const el = document.getElementById("cmts");
	if (!el) return;
	if (!d) { el.innerHTML = '<p class="dim" style="margin:6px 2px">comments won\'t load right now.</p>'; return; }
	el.innerHTML = d.comments.length ? d.comments.map(commentRow).join("") : '<p class="dim" style="margin:6px 2px">no comments on this one.</p>';
	const sum = document.getElementById("cmtsummary");
	if (sum && d.count) sum.textContent = "comments (" + d.count + ")";
	if (d.likes) {
		const lm = document.getElementById("likemeta");
		if (lm) lm.textContent = " · " + fmtLikes(d.likes) + " likes";
	}
}

async function showWatch(id) {
	setTab("");
	view.innerHTML = '<div class="watch"><div class="skel-player"></div><div class="skel-line" style="margin:14px 2px"></div><div class="skel-line short" style="margin:0 2px"></div></div>';
	let d;
	try { d = await api("watch?v=" + encodeURIComponent(id)); }
	catch (e) { return errBox("couldn't load that video."); }
	pushHistory({ id: d.id, title: d.title, uploader: d.uploader, thumb: d.thumb || "", dur: d.dur });
	const resume = store.settings.resume ? (store.progress[d.id] || 0) : 0;
	// quality ladder: HD adaptive pairs (video-only + shared audio track) first,
	// then the progressive fallbacks. played as a synced video+audio pair so the
	// box never transcodes.
	const prog = (d.streams || []).map((x) => ({ q: x.q, src: x.src, hd: false }));
	const hdv = (d.hd && d.hd.videos ? d.hd.videos : []).map((x) => ({ q: x.q, src: x.src, hd: true }));
	const seenQ = new Set();
	const qualities = hdv.concat(prog).filter((x) => { if (seenQ.has(x.q)) return false; seenQ.add(x.q); return true; });
	d._qualities = qualities;
	d._hdAudio = d.hd && d.hd.audio ? d.hd.audio : null;
	const hasStreams = qualities.length > 0 && (!hdv.length || d._hdAudio);
	let startIdx = 0;
	if (hasStreams) {
		if (store.settings.quality !== "auto") {
			const qi = qualities.findIndex((x) => x.q === store.settings.quality);
			if (qi >= 0) startIdx = qi;
		} else {
			// auto: 1080p HD when it's there (luke: full 1080p at least), else best available
			const qi = qualities.findIndex((x) => x.q === "1080p");
			startIdx = qi >= 0 ? qi : 0;
		}
	}
	const src = hasStreams ? qualities[startIdx].src : "";
	const metaBits = [fmtViews(d.views), d.uploaded ? d.uploaded.slice(0, 10) : "", d.likes ? fmtLikes(d.likes) + " likes" : ""].filter(Boolean).join(" · ");
	const subbed = isSubbed(d.uploader);
	const upLink = d.chId ? "#/c/" + encodeURIComponent(d.chId) : "#/s/" + encodeURIComponent(d.uploader);
	const qIdx = queue ? queue.items.findIndex((x) => x.id === d.id) : -1;
	const qChip = qIdx >= 0 ? `<p class="qchip">playing all · ${esc(queue.label)} · ${qIdx + 1}/${queue.items.length}</p>` : "";
	view.innerHTML = `<div class="watch">
		${hasStreams
			? `<div class="pwrap" id="pwrap"><video class="player${d.vertical ? " tall" : ""}" id="player" playsinline preload="metadata" crossorigin="anonymous" src="${esc(src)}"${qualities[startIdx] && qualities[startIdx].hd ? " muted" : ""}${d.thumb ? ` poster="${esc(d.thumb)}"` : ""}>${(d.captions || []).map((c, i) => `<track kind="captions" srclang="${esc(c.lang)}" label="${esc(c.label)}" src="${esc(c.src)}"${i === 0 ? " default" : ""}>`).join("")}</video>
				<div class="pspinner" id="pspinner" hidden></div>
				<button class="pplay" id="pplay" aria-label="Play">${ICON.playBig}</button>
				<div class="pctrl" id="pctrl">
					<div class="pseek" id="pseek"><div class="pseek-buf" id="pbuf"></div><div class="pseek-fill" id="pfill"></div></div>
					<div class="prow">
						<button class="pbtn" id="pbtn-play" aria-label="Play/pause">${ICON.play}</button>
						<span class="ptime" id="ptime">0:00 / 0:00</span>
						<span class="pgap"></span>
						<button class="pbtn" id="pbtn-mute" aria-label="Mute">${ICON.vol}</button>
						<button class="pbtn" id="pbtn-cc" aria-label="Captions" hidden>${ICON.cc}</button>
						<button class="pbtn pbtn-text" id="pbtn-speed" aria-label="Speed">1x</button>
						<button class="pbtn" id="pbtn-pip" aria-label="Picture in picture" hidden>${ICON.pip}</button>
						<button class="pbtn" id="pbtn-fs" aria-label="Fullscreen">${ICON.fs}</button>
					</div>
				</div>
			</div>`
			: `<div class="note">${d.live ? "this one's live - live playback isn't supported yet." : "no playable stream for this video."}</div>`}
		${qChip}
		<p class="wtitle">${esc(d.title)}</p>
		<div class="wsubrow">
			<p class="wmeta" style="margin:0"><a class="uplink" href="${upLink}">${esc(d.uploader)}</a>${metaBits ? " · " + esc(metaBits) : ""}<span id="likemeta"></span></p>
			<button class="plain" id="laterbtn">${isLater(d.id) ? "saved" : "later"}</button>
			<button class="plain subbtn${subbed ? " on" : ""}" id="subbtn">${subbed ? "subscribed" : "subscribe"}</button>
		</div>
		${hasStreams && qualities.length > 1 ? `<div class="wrow"><label class="dim" for="qual">quality</label><select class="quality" id="qual">${qualities.map((x, i) => `<option value="${i}"${i === startIdx ? " selected" : ""}>${esc(x.q)}${x.hd ? " hd" : ""}</option>`).join("")}</select></div>` : ""}
		${d.description ? `<details class="desc"><summary>description</summary><pre>${esc(d.description)}</pre></details>` : ""}
		${hasStreams ? '<details class="desc" id="cmtdetails"><summary id="cmtsummary">comments</summary><div class="cmts" id="cmts"><p class="dim" style="margin:6px 2px">loading comments...</p></div></details>' : ""}
	</div>`;
	const rel = store.settings.algo ? rankItems(d.related || []) : (d.related || []);
	view.innerHTML = `<div class="wcols">${view.innerHTML}<div class="railcol">${rel.length ? '<h2 class="sec">up next</h2>' : ""}${grid(rel)}</div></div>`;
	document.getElementById("subbtn").addEventListener("click", () => {
		toggleSub(d.uploader, d.chId || "");
		const b = document.getElementById("subbtn");
		const on = isSubbed(d.uploader);
		b.textContent = on ? "subscribed" : "subscribe";
		b.classList.toggle("on", on);
	});
	document.getElementById("laterbtn").addEventListener("click", () => {
		toggleLater({ id: d.id, title: d.title, uploader: d.uploader, thumb: d.thumb || "", dur: d.dur });
		document.getElementById("laterbtn").textContent = isLater(d.id) ? "saved" : "later";
	});
	const cdt = document.getElementById("cmtdetails");
	if (cdt) cdt.addEventListener("toggle", () => { if (cdt.open) fillComments(d.id); });
	if (hasStreams) wirePlayer(d, resume);
	// warm the next things he's likely to tap
	idle(() => {
		const nxt = queueNext(d.id) || ((d.related || [])[0]);
		if (nxt) prefetch("watch?v=" + nxt.id);
		if (d.chId) setTimeout(() => prefetch("channel?id=" + encodeURIComponent(d.chId)), 900);
		if (!rjLowData) setTimeout(() => fetchComments(d.id).then((c) => {
			if (!c) return;
			const sum = document.getElementById("cmtsummary");
			if (sum && c.count) sum.textContent = "comments (" + c.count + ")";
			const lm = document.getElementById("likemeta");
			if (lm && c.likes) lm.textContent = " · " + fmtLikes(c.likes) + " likes";
			if (cdt && cdt.open) fillComments(d.id);
		}), 1600);
	});
}

const ICON = {
	play: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>',
	pause: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
	playBig: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>',
	vol: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16 8a5 5 0 0 1 0 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
	mute: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>',
	cc: '<svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10.5 10.5c-.6-.6-2.5-.8-3.3.3-.8 1.2-.8 3.2 0 4.4.8 1.1 2.7.9 3.3.3M18 10.5c-.6-.6-2.5-.8-3.3.3-.8 1.2-.8 3.2 0 4.4.8 1.1 2.7.9 3.3.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
	fs: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
	pip: '<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><rect x="12" y="12" width="7" height="5" rx="1.5" fill="currentColor"/></svg>',
};
function fmtT(sec) { sec = Math.max(0, Math.floor(sec || 0)); return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0"); }
function wirePlayer(d, resume) {
	const v = document.getElementById("player");
	const wrap = document.getElementById("pwrap");
	if (!v || !wrap) return;
	const byId = (x) => document.getElementById(x);
	const playBtn = byId("pbtn-play"), bigPlay = byId("pplay"), spin = byId("pspinner"),
		seek = byId("pseek"), fill = byId("pfill"), buf = byId("pbuf"), timeEl = byId("ptime"),
		muteBtn = byId("pbtn-mute"), ccBtn = byId("pbtn-cc"), speedBtn = byId("pbtn-speed"), fsBtn = byId("pbtn-fs");

	// -- resume + progress + autoplay (unchanged behavior) --
	let lastSave = 0, firstMeta = true, pendingSeek = null;
	v.addEventListener("loadedmetadata", () => {
		if (pendingSeek != null) { v.currentTime = pendingSeek; pendingSeek = null; }
		else if (firstMeta && resume > 10 && resume < v.duration - 10) v.currentTime = resume;
		firstMeta = false; ui();
	});
	v.addEventListener("timeupdate", () => {
		if (Date.now() - lastSave > 5000) { lastSave = Date.now(); setProgress(d.id, v.currentTime); }
		ui();
	});
	v.addEventListener("pause", () => { setProgress(d.id, v.currentTime); ui(); showUI(); });
	window.addEventListener("pagehide", () => setProgress(d.id, v.currentTime), { once: true });
	v.addEventListener("ended", () => {
		setProgress(d.id, 0);
		if (!store.settings.autoplayNext) return;
		const qn = queueNext(d.id);
		if (qn) { location.hash = "#/w/" + qn.id; return; }
		const nxt = (d.related || [])[0];
		if (nxt) location.hash = "#/w/" + nxt.id;
	});
	// -- HD pair mode: video-only mp4 + separate audio element, kept in sync --
	let au = null;
	function ensureAudio() {
		if (au || !d._hdAudio) return au;
		au = new Audio(d._hdAudio);
		au.preload = "auto";
		au.id = "paudio";
		au.style.display = "none";
		document.body.appendChild(au); // dom-attached so ios keeps it alive + inspectable
		return au;
	}
	function syncAudio(hard) {
		if (!au) return;
		if (hard || Math.abs(au.currentTime - v.currentTime) > 0.35) au.currentTime = v.currentTime;
	}
	v.addEventListener("play", () => { if (au) { syncAudio(true); au.play().catch(() => {}); } });
	v.addEventListener("pause", () => { if (au) au.pause(); });
	v.addEventListener("seeked", () => syncAudio(true));
	v.addEventListener("volumechange", () => { if (au) { au.volume = v.muted ? 0 : v.volume; au.muted = v.muted; } });
	v.addEventListener("ratechange", () => { if (au) au.playbackRate = v.playbackRate; });
	const auTimer = setInterval(() => {
		if (!v.isConnected) { clearInterval(auTimer); return; }
		if (!au) return;
		if (v.paused) { if (!au.paused) au.pause(); return; }
		if (au.paused) { syncAudio(true); au.play().catch(() => {}); return; }
		if (Math.abs(au.currentTime - v.currentTime) > 0.3) au.currentTime = v.currentTime;
	}, 600);
	if (d._qualities[0] && d._qualities.some((x) => x.hd) && v.muted && d._hdAudio) {
		// initial source is HD - bring the audio pair up with it
		ensureAudio();
		if (au) { au.muted = false; au.volume = 1; }
	}
	const sel = document.getElementById("qual");
	if (sel) sel.addEventListener("change", () => {
		const q = d._qualities[Number(sel.value)];
		if (!q) return;
		const t = v.currentTime, playing = !v.paused;
		if (q.hd && d._hdAudio) {
			ensureAudio();
			v.muted = true; // video-only stream; the pair element carries sound
			v.src = q.src;
			if (au) { au.muted = false; }
		} else {
			if (au) { au.pause(); au.remove(); au = null; }
			v.muted = false;
			v.src = q.src;
		}
		pendingSeek = t;
		if (playing) v.play().catch(() => {});
	});

	// -- custom controls --
	function toggle() { if (v.paused) v.play().catch(() => {}); else v.pause(); }
	function ui() {
		const dur = v.duration || 0, t = v.currentTime || 0;
		const pct = dur ? (t / dur) * 100 : 0;
		fill.style.width = pct + "%";
		try { if (v.buffered.length && dur) buf.style.width = (v.buffered.end(v.buffered.length - 1) / dur) * 100 + "%"; } catch (e) {}
		timeEl.textContent = fmtT(t) + " / " + fmtT(dur);
		playBtn.innerHTML = v.paused ? ICON.play : ICON.pause;
		bigPlay.hidden = !v.paused;
		muteBtn.innerHTML = v.muted || v.volume === 0 ? ICON.mute : ICON.vol;
	}
	let hideT = null;
	function showUI() {
		wrap.classList.remove("hideui");
		clearTimeout(hideT);
		if (!v.paused && !v.ended) hideT = setTimeout(() => wrap.classList.add("hideui"), 2500);
	}
	function flash(txt) {
		const f = document.createElement("span");
		f.className = "pflash";
		f.textContent = txt;
		wrap.appendChild(f);
		setTimeout(() => f.remove(), 650);
	}
	function goFs() {
		if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
		if (wrap.requestFullscreen) wrap.requestFullscreen().catch(() => {});
		else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
	}
	v.addEventListener("play", () => { ui(); showUI(); });
	v.addEventListener("playing", () => { spin.hidden = true; ui(); });
	v.addEventListener("canplay", () => { spin.hidden = true; ui(); });
	v.addEventListener("waiting", () => { spin.hidden = false; });
	v.addEventListener("progress", ui);
	v.addEventListener("durationchange", ui);
	v.addEventListener("volumechange", ui);
	bigPlay.addEventListener("click", toggle);
	playBtn.addEventListener("click", () => { toggle(); showUI(); });
	muteBtn.addEventListener("click", () => { v.muted = !v.muted; showUI(); });
	fsBtn.addEventListener("click", () => { goFs(); showUI(); });
	const pipBtn = byId("pbtn-pip");
	if (document.pictureInPictureEnabled || v.webkitSupportsPresentationMode) {
		pipBtn.hidden = false;
		pipBtn.addEventListener("click", () => {
			if (document.pictureInPictureElement) { document.exitPictureInPicture().catch(() => {}); }
			else if (v.requestPictureInPicture) { v.requestPictureInPicture().catch(() => {}); }
			else if (v.webkitSupportsPresentationMode) { v.webkitSetPresentationMode(v.webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture"); }
			showUI();
		});
	}
	wrap.addEventListener("mousemove", showUI);
	wrap.addEventListener("touchstart", showUI, { passive: true });
	wrap.addEventListener("fullscreenchange", ui);

	// seek bar: tap or drag
	let scrubbing = false;
	function seekTo(clientX) {
		const r = seek.getBoundingClientRect();
		const pct = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
		if (v.duration) v.currentTime = pct * v.duration;
		ui();
	}
	seek.addEventListener("pointerdown", (e) => { scrubbing = true; try { seek.setPointerCapture(e.pointerId); } catch (err) {} seekTo(e.clientX); e.preventDefault(); showUI(); });
	seek.addEventListener("pointermove", (e) => { if (scrubbing) { seekTo(e.clientX); showUI(); } });
	seek.addEventListener("pointerup", () => { scrubbing = false; });

	// tap on the video: single toggles (short delay), double-tap edges seek +/-10s
	let tapT = 0, tapX = 0;
	v.addEventListener("click", (e) => {
		const now = Date.now();
		const r = v.getBoundingClientRect();
		const x = r.width ? (e.clientX - r.left) / r.width : 0.5;
		if (now - tapT < 300 && Math.abs(x - tapX) < 0.3) {
			tapT = 0;
			if (x < 0.4) { v.currentTime = Math.max(0, v.currentTime - 10); flash("-10s"); }
			else if (x > 0.6) { v.currentTime = Math.min(v.duration || 0, v.currentTime + 10); flash("+10s"); }
			else toggle();
		} else {
			tapT = now; tapX = x;
			setTimeout(() => { if (tapT && Date.now() - tapT >= 280) { tapT = 0; toggle(); } }, 300);
		}
		ui(); showUI();
	});

	// captions toggle (first track = the english default from v1.4)
	if (v.textTracks && v.textTracks.length) {
		ccBtn.hidden = false;
		const tt = v.textTracks[0];
		const syncCc = () => ccBtn.classList.toggle("on", tt.mode === "showing");
		ccBtn.addEventListener("click", () => { tt.mode = tt.mode === "showing" ? "hidden" : "showing"; syncCc(); showUI(); });
		syncCc();
	}

	// playback speed cycle
	const RATES = [1, 1.25, 1.5, 2, 0.75];
	speedBtn.addEventListener("click", () => {
		const i = RATES.indexOf(v.playbackRate);
		v.playbackRate = RATES[(i + 1) % RATES.length];
		speedBtn.textContent = ("" + v.playbackRate).replace(/\./, ".") + "x";
		showUI();
	});

	// keyboard (desktop) - self-removes when the player leaves the dom
	document.addEventListener("keydown", function kh(e) {
		if (!v.isConnected) { document.removeEventListener("keydown", kh); return; }
		const t = e.target;
		if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
		const k = e.key.toLowerCase();
		if (k === " " || k === "k") { e.preventDefault(); toggle(); }
		else if (k === "j") { v.currentTime = Math.max(0, v.currentTime - 10); flash("-10s"); }
		else if (k === "l") { v.currentTime = Math.min(v.duration || 0, v.currentTime + 10); flash("+10s"); }
		else if (k === "arrowleft") { v.currentTime = Math.max(0, v.currentTime - 5); }
		else if (k === "arrowright") { v.currentTime = Math.min(v.duration || 0, v.currentTime + 5); }
		else if (k === "m") { v.muted = !v.muted; }
		else if (k === "f") { goFs(); }
		else return;
		ui(); showUI();
	});

	ui();
}

function showHistory() {
	setTab("history");
	const laterRows = store.later.map((v) => `<div class="subrow">
		<a class="subname" href="#/w/${esc(v.id)}">${esc(v.title)}</a>
		<button class="plain" data-unlater="${esc(v.id)}">remove</button>
	</div>`).join("");
	const laterHtml = store.later.length ? `<h2 class="sec pad" style="padding-bottom:0">watch later (${store.later.length})</h2><div class="subs">${laterRows}</div>` : "";
	if (!store.history.length) {
		view.innerHTML = laterHtml || '<p class="dim pad">nothing watched yet.</p>';
		for (const b of document.querySelectorAll("[data-unlater]")) b.addEventListener("click", () => { store.later = store.later.filter((x) => x.id !== b.dataset.unlater); save(); showHistory(); });
		return;
	}
	const items = store.history.map((h) => {
		const p = store.progress[h.id];
		return {
			...h,
			resume: p && h.durSec && p < h.durSec - 15 ? "resume " + Math.floor(p / 60) + ":" + String(p % 60).padStart(2, "0") : "",
			progressPct: p && h.durSec ? Math.round((p / h.durSec) * 100) : 0,
		};
	});
	view.innerHTML = laterHtml + `<h2 class="sec pad" style="padding-bottom:0">watch history</h2>` + grid(items) +
		`<div class="pad"><button class="plain" id="wipe">clear history</button></div>`;
	for (const b of document.querySelectorAll("[data-unlater]")) b.addEventListener("click", () => { store.later = store.later.filter((x) => x.id !== b.dataset.unlater); save(); showHistory(); });
	document.getElementById("wipe").addEventListener("click", () => {
		store.history = []; store.progress = {}; save(); showHistory();
	});
}

// -- subscriptions --------------------------------------------------------------
function subLink(s) { return s.chId ? "#/c/" + encodeURIComponent(s.chId) : "#/s/" + encodeURIComponent(s.name); }
async function showSubs() {
	setTab("subs");
	if (!store.subs.length) {
		view.innerHTML = '<div class="note"><p>no subscriptions yet.</p><p class="dim" style="margin:0">hit subscribe on any watch page and that channel lands here, synced to your ramjet account.</p></div>';
		return;
	}
	const rows = store.subs.map((s) => `<div class="subrow">
		<a class="subname" href="${subLink(s)}">${esc(s.name)}</a>
		<button class="plain" data-unsub="${esc(s.name)}">unsubscribe</button>
	</div>`).join("");
	view.innerHTML = `<h2 class="sec pad" style="padding-bottom:0">subscriptions</h2><div class="subs">${rows}</div><h2 class="sec pad" style="padding-bottom:0">latest from your channels</h2><div id="subsfeed">${skeleton()}</div>`;
	for (const b of document.querySelectorAll("[data-unsub]")) {
		b.addEventListener("click", () => { toggleSub(b.dataset.unsub); showSubs(); });
	}
	// latest: top videos per channel via search, merged, deduped
	try {
		const names = store.subs.slice(0, 8).map((s) => s.name);
		const results = await Promise.all(names.map((n) => api("search?q=" + encodeURIComponent(n)).catch(() => ({ items: [] }))));
		const seen = new Set();
		const merged = [];
		results.forEach((d, i) => {
			const want = names[i].toLowerCase();
			for (const it of d.items || []) {
				if ((it.uploader || "").toLowerCase() !== want) continue;
				if (seen.has(it.id)) continue;
				seen.add(it.id);
				merged.push(it);
				if (merged.filter((x) => (x.uploader || "").toLowerCase() === want).length >= 2) break;
			}
		});
		document.getElementById("subsfeed").innerHTML = grid(merged.slice(0, 24));
	} catch (e) {
		document.getElementById("subsfeed").innerHTML = '<p class="dim pad">the feed is rate-limited right now - try again in a bit.</p>';
	}
}

// -- settings ------------------------------------------------------------------
function showSettings() {
	setTab("settings");
	const s = store.settings;
	view.innerHTML = `<div class="pad">
		<h2 class="sec" style="padding:0 0 6px">settings</h2>
		<div class="setrow"><span>autoplay next video</span><input type="checkbox" id="set-autoplay"${s.autoplayNext ? " checked" : ""}></div>
		<div class="setrow"><span>resume where i left off</span><input type="checkbox" id="set-resume"${s.resume ? " checked" : ""}></div>
		<div class="setrow"><span>for-you ranking</span><input type="checkbox" id="set-algo"${s.algo ? " checked" : ""}></div>
		<div class="setrow"><span>clear watch history when i close jetstream</span><input type="checkbox" id="set-wipe"${s.clearOnExit ? " checked" : ""}></div>
		<div class="setrow"><span>default quality</span><select class="quality" id="set-quality">
			<option value="auto"${s.quality === "auto" ? " selected" : ""}>auto</option>
			<option value="1080p"${s.quality === "1080p" ? " selected" : ""}>1080p</option>
			<option value="720p"${s.quality === "720p" ? " selected" : ""}>720p</option>
			<option value="480p"${s.quality === "480p" ? " selected" : ""}>480p</option>
			<option value="360p"${s.quality === "360p" ? " selected" : ""}>360p</option>
		</select></div>
		<p class="dim" style="font-size:12.5px">synced to your ramjet account - same settings, history and subscriptions on every device.</p>
	</div>`;
	document.getElementById("set-autoplay").addEventListener("change", (e) => { store.settings.autoplayNext = e.target.checked; save(); });
	document.getElementById("set-resume").addEventListener("change", (e) => { store.settings.resume = e.target.checked; save(); });
	document.getElementById("set-quality").addEventListener("change", (e) => { store.settings.quality = e.target.value; save(); });
	document.getElementById("set-algo").addEventListener("change", (e) => { store.settings.algo = e.target.checked; save(); });
	document.getElementById("set-wipe").addEventListener("change", (e) => { store.settings.clearOnExit = e.target.checked; save(); });
}

// -- router ---------------------------------------------------------------------
// paste a youtube link in the search box and we go straight there
function routeUrl(raw) {
	let m;
	if ((m = /(?:shorts\/|watch\?[^\s]*v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/.exec(raw))) return "#/w/" + m[1];
	if ((m = /[?&]list=([a-zA-Z0-9_-]{10,80})/.exec(raw))) return "#/p/" + m[1];
	if ((m = /channel\/([a-zA-Z0-9_-]{20,40})/.exec(raw))) return "#/c/" + m[1];
	return null;
}
function route() {
	const h = location.hash || "#/";
	view.classList.remove("fade-in");
	void view.offsetWidth;
	view.classList.add("fade-in");
	if (h.startsWith("#/w/")) return showWatch(h.slice(4).split("?")[0]);
	if (h.startsWith("#/c/")) return showChannel(h.slice(4).split("?")[0]);
	if (h.startsWith("#/p/")) return showPlaylist(h.slice(4).split("?")[0]);
	if (h.startsWith("#/s/")) return showSearch(decodeURIComponent(h.slice(4)));
	if (h === "#/trending") return showTrending();
	if (h === "#/history") return showHistory();
	if (h === "#/subs") return showSubs();
	if (h === "#/settings") return showSettings();
	return showForYou();
}

document.getElementById("search").addEventListener("submit", (e) => {
	e.preventDefault();
	const q = qInput.value.trim();
	if (!q) return;
	const direct = routeUrl(q);
	location.hash = direct || "#/s/" + encodeURIComponent(q);
});
// -- search suggestions --------------------------------------------------------
// server-side suggestions (youtube suggest via our api - no google domains
// client-side), subtle dropdown, keyboard friendly, never covers results.
(function suggestions() {
	const form = document.getElementById("search");
	const box = document.createElement("div");
	box.className = "sugs";
	box.hidden = true;
	form.appendChild(box);
	let items = [], active = -1, timer = null, lastQ = "";
	function hide() { box.hidden = true; active = -1; }
	function render() {
		if (!items.length) return hide();
		box.innerHTML = items.map((t, i) => `<button type="button" class="sug${i === active ? " on" : ""}" data-i="${i}">${esc(t)}</button>`).join("");
		box.hidden = false;
		for (const b of box.querySelectorAll(".sug")) b.addEventListener("pointerdown", (e) => { e.preventDefault(); pick(items[Number(b.dataset.i)]); });
	}
	function pick(t) { qInput.value = t; hide(); if (form.requestSubmit) form.requestSubmit(); }
	qInput.addEventListener("input", () => {
		clearTimeout(timer);
		const q = qInput.value.trim();
		if (q.length < 2) { hide(); return; }
		timer = setTimeout(async () => {
			try {
				const d = await api("suggest?q=" + encodeURIComponent(q));
				if (qInput.value.trim() !== q) return;
				lastQ = q; items = (d.items || []).slice(0, 6); active = -1; render();
			} catch (e) {}
		}, 180);
	});
	qInput.addEventListener("keydown", (e) => {
		if (box.hidden) return;
		if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(items.length - 1, active + 1); render(); if (active >= 0) qInput.value = items[active]; }
		else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(-1, active - 1); render(); if (active >= 0) qInput.value = items[active]; }
		else if (e.key === "Enter" && active >= 0) { e.preventDefault(); pick(items[active]); }
		else if (e.key === "Escape") hide();
	});
	qInput.addEventListener("blur", () => setTimeout(hide, 150));
	qInput.addEventListener("focus", () => { if (items.length && qInput.value.trim() === lastQ && qInput.value.trim().length > 1) render(); });
})();

function wipeHistoryOnExit() {
	if (!store.settings.clearOnExit) return;
	store.history = []; store.progress = {};
	try { localStorage.setItem(LS_KEY, JSON.stringify(store)); } catch (e) {}
	if (typeof RJCrypto !== "undefined" && RJCrypto.unlocked()) {
		RJCrypto.pull().then((blob) => {
			blob = blob || {};
			blob.jetstream = { history: [], progress: {}, settings: store.settings, subs: store.subs, later: store.later.slice(0, 60) };
			RJCrypto.push(blob).catch(() => {});
		}).catch(() => {});
	}
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") wipeHistoryOnExit(); });
window.addEventListener("pagehide", wipeHistoryOnExit);
window.addEventListener("hashchange", route);
loadLocal();
route();
loadRemote().then(() => { const h = location.hash || "#/"; if (h === "#/" || h === "#/foryou" || h === "#/trending" || h === "#/history" || h === "#/subs" || h === "#/settings") route(); });
