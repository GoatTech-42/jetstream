// jetstream client - hash-routed youtube frontend riding ramjet's session.
// per-user data (history, resume, settings, subscriptions) syncs through
// ramjet's encrypted sync blob under the "jetstream" key, localStorage
// fallback when sync is locked or off.
const view = document.getElementById("view");
const qInput = document.getElementById("q");
const LS_KEY = "jetstream-store";
const DEFAULT_SETTINGS = { autoplayNext: true, resume: true, quality: "auto", algo: true };

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
function fmtViews(v) {
	v = Number(v) || 0;
	if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M views";
	if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "K views";
	return v + " views";
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

async function showTrending() {
	setTab("home");
	view.innerHTML = skeleton();
	try {
		const d = await api("trending");
		const items = store.settings.algo ? rankItems(d.items || []) : (d.items || []);
		view.innerHTML = grid(items);
		// warm the watch payloads he's most likely to open
		const top = items.slice(0, 3);
		if (top.length) idle(() => top.forEach((it, i) => setTimeout(() => prefetch("watch?v=" + it.id), i * 900)));
	} catch (e) { errBox("trending won't load right now - the upstream is probably rate-limited."); }
}

async function showSearch(q) {
	setTab("");
	qInput.value = q;
	view.innerHTML = skeleton();
	try {
		const d = await api("search?q=" + encodeURIComponent(q));
		const items = d.items || [];
		view.innerHTML = `<h2 class="sec pad" style="padding-bottom:0">results for "${esc(q)}"</h2>
		<div class="fchips pad" style="padding-top:8px;padding-bottom:0" id="fchips">
			<button class="fchip on" data-f="videos">videos</button><button class="fchip" data-f="channels">channels</button><button class="fchip" data-f="playlists">playlists</button>
		</div><div id="sresults">` + (items.length ? grid(items) : '<p class="dim pad">no videos matched that.</p>') + "</div>";
		const resultsEl = document.getElementById("sresults");
		const searches = {
			videos: () => api("search?q=" + encodeURIComponent(q)).then((d) => (d.items && d.items.length ? grid(store.settings.algo ? rankItems(d.items) : d.items) : '<p class="dim pad">no videos matched that.</p>')),
			channels: () => api("search-channels?q=" + encodeURIComponent(q)).then((d) => {
				const cs = (d && d.items) || [];
				if (!cs.length) return '<p class="dim pad">no channels matched that.</p>';
				return '<div class="plrow">' + cs.map((c) => `<a class="plcard" href="#/c/${esc(c.id)}">
					${c.avatar ? `<img loading="lazy" src="${esc(c.avatar)}" alt="" style="border-radius:50%">` : ""}
					<span class="plinfo"><b>${esc(c.name)}</b><span class="dim">${c.subs > 0 ? fmtViews(c.subs).replace("views", "subscribers") : "channel"}${c.description ? " · " + esc(c.description) : ""}</span></span>
				</a>`).join("") + "</div>";
			}),
			playlists: () => api("search-playlists?q=" + encodeURIComponent(q)).then((p) => {
				const pls = (p && p.items) || [];
				if (!pls.length) return '<p class="dim pad">no playlists matched that.</p>';
				return '<div class="plrow">' + pls.map((pl) => `<a class="plcard" href="#/p/${esc(pl.id)}">
					${pl.thumb ? `<img loading="lazy" src="${esc(pl.thumb)}" alt="">` : ""}
					<span class="plinfo"><b>${esc(pl.title)}</b><span class="dim">playlist${pl.count ? " · " + pl.count + " videos" : ""}${pl.uploader ? " · " + esc(pl.uploader) : ""}</span></span>
				</a>`).join("") + "</div>";
			}),
		};
		for (const b of document.querySelectorAll(".fchip")) {
			b.addEventListener("click", () => {
				if (b.classList.contains("on")) return;
				for (const x of document.querySelectorAll(".fchip")) x.classList.remove("on");
				b.classList.add("on");
				resultsEl.innerHTML = skeleton();
				(searches[b.dataset.f] || searches.videos)().then((html) => { resultsEl.innerHTML = html; }).catch(() => { resultsEl.innerHTML = '<p class="dim pad">that search failed - try again.</p>'; });
			});
		}
	} catch (e) { errBox("search failed - give it another try."); }
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
		</div>
		<button class="plain subbtn${subbed ? " on" : ""}" id="subbtn">${subbed ? "subscribed" : "subscribe"}</button>
	</div>
	${vids.length ? `<div class="pad" style="padding-top:0"><button class="plain" id="playall">play all (${vids.length})</button></div>` : ""}
	${d.description ? `<details class="desc pad" style="padding-top:0"><summary>about</summary><pre>${esc(d.description)}</pre></details>` : ""}
	${shorts.length ? `<h2 class="sec">shorts</h2><div class="shortrow">${shorts.map(shortCard).join("")}</div>` : ""}
	${pls.length ? `<h2 class="sec">playlists</h2><div class="plrow">${pls.map((pl) => `<a class="plcard" href="#/p/${esc(pl.id)}">
		${pl.thumb ? `<img loading="lazy" src="${esc(pl.thumb)}" alt="">` : ""}
		<span class="plinfo"><b>${esc(pl.title)}</b><span class="dim">playlist</span></span>
	</a>`).join("")}</div>` : ""}
	${vids.length ? '<h2 class="sec">videos</h2>' + grid(vids) : ""}
	${!vids.length && !shorts.length ? '<p class="dim pad">no videos found on this channel.</p>' : ""}`;
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
		if (lm) lm.textContent = " · " + d.likes + " likes";
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
	const hasStreams = d.streams && d.streams.length > 0;
	let startIdx = 0;
	if (hasStreams && store.settings.quality !== "auto") {
		const qi = d.streams.findIndex((s) => s.q === store.settings.quality);
		if (qi >= 0) startIdx = qi;
	}
	const src = hasStreams ? d.streams[startIdx].src : "";
	const metaBits = [fmtViews(d.views), d.uploaded ? d.uploaded.slice(0, 10) : "", d.likes ? d.likes + " likes" : ""].filter(Boolean).join(" · ");
	const subbed = isSubbed(d.uploader);
	const upLink = d.chId ? "#/c/" + encodeURIComponent(d.chId) : "#/s/" + encodeURIComponent(d.uploader);
	const qIdx = queue ? queue.items.findIndex((x) => x.id === d.id) : -1;
	const qChip = qIdx >= 0 ? `<p class="qchip">playing all · ${esc(queue.label)} · ${qIdx + 1}/${queue.items.length}</p>` : "";
	view.innerHTML = `<div class="watch">
		${hasStreams
			? `<video class="player${d.vertical ? " tall" : ""}" id="player" controls playsinline preload="metadata" crossorigin="anonymous" src="${esc(src)}"${d.thumb ? ` poster="${esc(d.thumb)}"` : ""}>${(d.captions || []).map((c, i) => `<track kind="captions" srclang="${esc(c.lang)}" label="${esc(c.label)}" src="${esc(c.src)}"${i === 0 ? " default" : ""}>`).join("")}</video>`
			: `<div class="note">${d.live ? "this one's live - live playback isn't supported yet." : "no playable stream for this video."}</div>`}
		${qChip}
		<p class="wtitle">${esc(d.title)}</p>
		<div class="wsubrow">
			<p class="wmeta" style="margin:0"><a class="uplink" href="${upLink}">${esc(d.uploader)}</a>${metaBits ? " · " + esc(metaBits) : ""}<span id="likemeta"></span></p>
			<button class="plain" id="laterbtn">${isLater(d.id) ? "saved" : "later"}</button>
			<button class="plain subbtn${subbed ? " on" : ""}" id="subbtn">${subbed ? "subscribed" : "subscribe"}</button>
		</div>
		${hasStreams && d.streams.length > 1 ? `<div class="wrow"><label class="dim" for="qual">quality</label><select class="quality" id="qual">${d.streams.map((s, i) => `<option value="${i}"${i === startIdx ? " selected" : ""}>${esc(s.q)}</option>`).join("")}</select></div>` : ""}
		${d.description ? `<details class="desc"><summary>description</summary><pre>${esc(d.description)}</pre></details>` : ""}
		${hasStreams ? '<details class="desc" id="cmtdetails"><summary id="cmtsummary">comments</summary><div class="cmts" id="cmts"><p class="dim" style="margin:6px 2px">loading comments...</p></div></details>' : ""}
		${d.related && d.related.length ? '<h2 class="sec">up next</h2>' : ""}
	</div>` + grid(store.settings.algo ? rankItems(d.related || []) : (d.related || []));
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
			if (lm && c.likes) lm.textContent = " · " + c.likes + " likes";
			if (cdt && cdt.open) fillComments(d.id);
		}), 1600);
	});
}

function wirePlayer(d, resume) {
	const v = document.getElementById("player");
	if (!v) return;
	let lastSave = 0;
	v.addEventListener("loadedmetadata", () => {
		if (resume > 10 && resume < v.duration - 10) v.currentTime = resume;
	});
	v.addEventListener("timeupdate", () => {
		if (Date.now() - lastSave > 5000) { lastSave = Date.now(); setProgress(d.id, v.currentTime); }
	});
	v.addEventListener("pause", () => setProgress(d.id, v.currentTime));
	window.addEventListener("pagehide", () => setProgress(d.id, v.currentTime), { once: true });
	v.addEventListener("ended", () => {
		setProgress(d.id, 0);
		if (!store.settings.autoplayNext) return;
		const qn = queueNext(d.id);
		if (qn) { location.hash = "#/w/" + qn.id; return; }
		const nxt = (d.related || [])[0];
		if (nxt) location.hash = "#/w/" + nxt.id;
	});
	const sel = document.getElementById("qual");
	if (sel) sel.addEventListener("change", () => {
		const t = v.currentTime, playing = !v.paused;
		v.src = d.streams[Number(sel.value)].src;
		v.currentTime = t;
		if (playing) v.play().catch(() => {});
	});
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
		<div class="setrow"><span>default quality</span><select class="quality" id="set-quality">
			<option value="auto"${s.quality === "auto" ? " selected" : ""}>auto</option>
			<option value="720p"${s.quality === "720p" ? " selected" : ""}>720p</option>
			<option value="360p"${s.quality === "360p" ? " selected" : ""}>360p</option>
		</select></div>
		<p class="dim" style="font-size:12.5px">synced to your ramjet account - same settings, history and subscriptions on every device.</p>
	</div>`;
	document.getElementById("set-autoplay").addEventListener("change", (e) => { store.settings.autoplayNext = e.target.checked; save(); });
	document.getElementById("set-resume").addEventListener("change", (e) => { store.settings.resume = e.target.checked; save(); });
	document.getElementById("set-quality").addEventListener("change", (e) => { store.settings.quality = e.target.value; save(); });
	document.getElementById("set-algo").addEventListener("change", (e) => { store.settings.algo = e.target.checked; save(); });
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
	if (h === "#/history") return showHistory();
	if (h === "#/subs") return showSubs();
	if (h === "#/settings") return showSettings();
	return showTrending();
}

document.getElementById("search").addEventListener("submit", (e) => {
	e.preventDefault();
	const q = qInput.value.trim();
	if (!q) return;
	const direct = routeUrl(q);
	location.hash = direct || "#/s/" + encodeURIComponent(q);
});
window.addEventListener("hashchange", route);
loadLocal();
route();
loadRemote().then(() => { const h = location.hash || "#/"; if (h === "#/history" || h === "#/subs" || h === "#/settings") route(); });
